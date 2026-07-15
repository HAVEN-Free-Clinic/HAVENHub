import type { Application } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { reviewScope, RecruitmentAuthError, AcceptanceError } from "./review";

export class RoutingError extends Error {
  constructor(message: string) { super(message); this.name = "RoutingError"; }
}

/** A recruitment lead assigns the committee's best-fit department. Routing may
 *  be off-choice (the UI flags it); the derived flag is
 *  `!application.departmentChoices.includes(routedDepartmentCode)`. */
export async function routeApplication(
  applicationId: string,
  departmentCode: string,
  actorId: string,
): Promise<Application> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't route applications.");
  }
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { cycle: { select: { departments: true, track: true } } },
  });
  if (!app) throw new RoutingError("Application not found.");
  if (app.status !== "SUBMITTED") throw new RoutingError("This application hasn't been submitted yet.");
  if (app.cycle.track !== "VOLUNTEER") throw new RoutingError("Routing applies to volunteer cycles.");
  if (!app.cycle.departments.includes(departmentCode)) throw new RoutingError("That department is not part of this cycle.");

  const previous = app.routedDepartmentCode;
  const isReroute = previous != null && previous !== departmentCode;

  // Re-routing to a DIFFERENT department invalidates any decision already recorded
  // for the previous department. Without this cleanup the old Acceptance survives,
  // so a later REJECT on the new department still leaves a live acceptance for the
  // old one -- the applicant would be emailed an acceptance and land on the old
  // roster despite being rejected, and Application.decision would describe a
  // department the applicant is no longer routed to. Block the re-route when that
  // acceptance was already emailed or has an onboarding contract (must be rescinded
  // or torn down first, mirroring decideRoutedApplication); otherwise clear the
  // stale acceptance and reset the decision so the new department decides fresh.
  const updated = await prisma.$transaction(async (tx) => {
    if (isReroute) {
      const stale = await tx.acceptance.findUnique({
        where: { applicationId_departmentCode: { applicationId, departmentCode: previous } },
        include: { contract: { select: { id: true } } },
      });
      if (stale?.emailedAt || stale?.contract) {
        throw new AcceptanceError(
          `This applicant was already emailed their acceptance for ${previous} or has started onboarding. Rescind it before re-routing.`,
        );
      }
      if (stale) await tx.acceptance.delete({ where: { id: stale.id } });
    }
    return tx.application.update({
      where: { id: applicationId },
      data: {
        routedDepartmentCode: departmentCode,
        routedById: actorId,
        routedAt: new Date(),
        ...(isReroute ? { decision: "PENDING", decidedById: null, decidedAt: null, decisionNotes: null } : {}),
      },
    });
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.route", entityType: "Application", entityId: applicationId, after: { departmentCode, ...(isReroute ? { rerouteFrom: previous } : {}) } });
  return updated;
}

/** A department director (or SRR) records the final decision on a VOLUNTEER
 *  application routed to their department -- no interview. ACCEPT mints an
 *  Acceptance (feeding release/onboarding); the outcome is stored on
 *  Application.decision. Mirrors decideInterview's acceptance sync. */
export async function decideRoutedApplication(
  applicationId: string,
  outcome: "ACCEPT" | "REJECT" | "WAITLIST",
  deciderId: string,
  notes: string | null,
): Promise<Application> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: {
      status: true,
      routedDepartmentCode: true,
      cycle: { select: { track: true } },
      applicant: { select: { applicantPersonId: true } },
    },
  });
  if (!app) throw new RoutingError("Application not found.");
  if (app.status !== "SUBMITTED") throw new RoutingError("This application hasn't been submitted yet.");
  if (app.cycle.track !== "VOLUNTEER") throw new RoutingError("Director applications are decided from the interview.");
  if (!app.routedDepartmentCode) throw new RoutingError("Route this applicant to a department before deciding.");
  const departmentCode = app.routedDepartmentCode;
  // Separation of duties: a signed-in applicant who also reviews must not decide
  // their own application (mirrors acceptApplicant/decideInterview).
  if (app.applicant.applicantPersonId && app.applicant.applicantPersonId === deciderId) {
    throw new RecruitmentAuthError("You can't decide your own application.");
  }
  const scope = await reviewScope(deciderId);
  if (!(scope.all || scope.departmentCodes.includes(departmentCode))) {
    throw new RecruitmentAuthError("You can't decide applications for that department.");
  }
  const key = { applicationId_departmentCode: { applicationId, departmentCode } };
  const updated = await prisma.$transaction(async (tx) => {
    if (outcome === "ACCEPT") {
      // Idempotent + race-safe, like decideInterview: keep any existing acceptance.
      await tx.acceptance.createMany({
        data: [{ applicationId, departmentCode, approvedById: deciderId, notes }],
        skipDuplicates: true,
      });
    } else {
      const existing = await tx.acceptance.findUnique({ where: key, include: { contract: { select: { id: true } } } });
      if (existing?.emailedAt || existing?.contract) {
        throw new AcceptanceError("This applicant has already been emailed their acceptance or started onboarding. Rescind the acceptance before changing this decision.");
      }
      if (existing) await tx.acceptance.delete({ where: { id: existing.id } });
    }
    return tx.application.update({
      where: { id: applicationId },
      data: { decision: outcome, decidedById: deciderId, decidedAt: new Date(), decisionNotes: notes },
    });
  });
  await recordAudit({ actorPersonId: deciderId, action: "recruitment.application_decide", entityType: "Application", entityId: applicationId, after: { decision: outcome, departmentCode } });
  return updated;
}

/** Reject a VOLUNTEER application without routing it (bottom-tier speed route, or
 *  a standalone SRR reject). Sets Application.decision = REJECT with no Acceptance
 *  and leaves routedDepartmentCode as-is. A prior not-emailed acceptance is torn
 *  down so releaseDecisions can't still email it. No email fires here; reversible
 *  via reopenDecision until an acceptance is emailed or decisions are released. */
export async function rejectApplication(
  applicationId: string,
  actorId: string,
  notes: string | null,
): Promise<Application> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't reject applications.");
  }
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: {
      cycle: { select: { track: true } },
      applicant: { select: { applicantPersonId: true } },
      acceptances: { select: { emailedAt: true, contract: { select: { id: true } } } },
    },
  });
  if (!app) throw new RoutingError("Application not found.");
  if (app.status !== "SUBMITTED") throw new RoutingError("This application hasn't been submitted yet.");
  if (app.cycle.track !== "VOLUNTEER") throw new RoutingError("Routing applies to volunteer cycles.");
  // Separation of duties: a signed-in applicant who reviews must not decide their own.
  if (app.applicant.applicantPersonId && app.applicant.applicantPersonId === actorId) {
    throw new RecruitmentAuthError("You can't decide your own application.");
  }
  // An emailed acceptance or an onboarding contract must be torn down first (mirrors
  // decideRoutedApplication / revokeAcceptance): rejecting under it would leave the
  // applicant emailed-accepted-yet-rejected, or destroy onboarding data on cascade.
  if (app.acceptances.some((a) => a.emailedAt != null || a.contract != null)) {
    throw new AcceptanceError("This applicant has an emailed acceptance or onboarding contract. Resolve that before rejecting.");
  }
  const updated = await prisma.$transaction(async (tx) => {
    // Remaining acceptances are not-emailed and contract-free (guarded above); drop
    // them so a stale ACCEPT can't survive a REJECT.
    await tx.acceptance.deleteMany({ where: { applicationId, emailedAt: null } });
    return tx.application.update({
      where: { id: applicationId },
      data: { decision: "REJECT", decidedById: actorId, decidedAt: new Date(), decisionNotes: notes },
    });
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.application_reject", entityType: "Application", entityId: applicationId, after: { decision: "REJECT" } });
  return updated;
}

/** Reverse a not-emailed decision (typically a speed-route reject) back to PENDING.
 *  Leaves any routing intact. Blocked once the applicant was emailed an acceptance
 *  or the cycle's decisions were released. */
export async function reopenDecision(applicationId: string, actorId: string): Promise<Application> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't reopen decisions.");
  }
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { cycle: { select: { decisionsReleasedAt: true, track: true } }, acceptances: { select: { emailedAt: true } } },
  });
  if (!app) throw new RoutingError("Application not found.");
  if (app.status !== "SUBMITTED") throw new RoutingError("This application hasn't been submitted yet.");
  if (app.cycle.track !== "VOLUNTEER") throw new RoutingError("Routing applies to volunteer cycles.");
  if (app.decision === "PENDING") throw new RoutingError("This application has no decision to reopen.");
  if (app.cycle.decisionsReleasedAt) throw new AcceptanceError("Decisions were already released; reopening is blocked.");
  if (app.acceptances.some((a) => a.emailedAt != null)) throw new AcceptanceError("This applicant was already emailed; reopening is blocked.");
  const updated = await prisma.application.update({
    where: { id: applicationId },
    data: { decision: "PENDING", decidedById: null, decidedAt: null, decisionNotes: null },
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.application_reopen", entityType: "Application", entityId: applicationId, after: { decision: "PENDING" } });
  return updated;
}
