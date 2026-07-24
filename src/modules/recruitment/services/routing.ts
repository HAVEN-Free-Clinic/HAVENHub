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
  // Reset the decision when routing changes which department owns it:
  //  - a re-route to a DIFFERENT department (isReroute), the existing behavior; or
  //  - the FIRST routing of an application that already carries a decision made with
  //    no department (previous == null), i.e. a bottom-tier speed reject that set
  //    decision=REJECT with routedDepartmentCode still null -- the new department must
  //    decide fresh rather than inherit a stale REJECT. Such an app has no live
  //    acceptance (rejectApplication tears them down), so no teardown is needed here.
  // A re-route to the SAME department (previous == departmentCode) is a no-op that
  // must PRESERVE the existing decision + acceptance, so it is deliberately excluded.
  const clearDecision = isReroute || (previous == null && app.decision !== "PENDING");

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
      // Atomic teardown of the stale acceptance: delete only while still not-emailed.
      // A concurrent releaseDecisions that stamped emailedAt after the read above makes
      // this remove nothing -- abort rather than orphan an emailed acceptance.
      if (stale) {
        const del = await tx.acceptance.deleteMany({ where: { id: stale.id, emailedAt: null } });
        if (del.count === 0) {
          throw new AcceptanceError(
            `This applicant was already emailed their acceptance for ${previous} or has started onboarding. Rescind it before re-routing.`,
          );
        }
      }
    }
    return tx.application.update({
      where: { id: applicationId },
      data: {
        routedDepartmentCode: departmentCode,
        routedById: actorId,
        routedAt: new Date(),
        ...(clearDecision ? { decision: "PENDING", decidedById: null, decidedAt: null, decisionNotes: null } : {}),
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
      decision: true,
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
      // Atomic teardown (see decideInterview): delete only while not-emailed so a
      // concurrent release can't leave an emailed-but-rejected applicant.
      if (existing) {
        const del = await tx.acceptance.deleteMany({ where: { id: existing.id, emailedAt: null } });
        if (del.count === 0) {
          throw new AcceptanceError("This applicant has already been emailed their acceptance or started onboarding. Rescind the acceptance before changing this decision.");
        }
      }
    }
    // #106: gate on the decision we read, mirroring decideInterview -- a concurrent
    // ACCEPT/REJECT must not leave the decision disagreeing with the Acceptance row.
    const claimed = await tx.application.updateMany({
      where: { id: applicationId, decision: app.decision },
      data: { decision: outcome, decidedById: deciderId, decidedAt: new Date(), decisionNotes: notes },
    });
    if (claimed.count === 0) {
      throw new RoutingError("This application was just decided by someone else. Refresh and try again.");
    }
    return tx.application.findUniqueOrThrow({ where: { id: applicationId } });
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
    // Drop not-emailed acceptances so a stale ACCEPT can't survive a REJECT. The guard
    // above read acceptances OUTSIDE this tx, so a concurrent releaseDecisions could
    // have stamped emailedAt in the gap -- which the deleteMany (emailedAt: null) won't
    // remove. Re-check inside the tx: any surviving acceptance is a live emailed one,
    // so abort instead of flipping decision to REJECT under an emailed acceptance.
    await tx.acceptance.deleteMany({ where: { applicationId, emailedAt: null } });
    if ((await tx.acceptance.count({ where: { applicationId } })) > 0) {
      throw new AcceptanceError("This applicant has an emailed acceptance or onboarding contract. Resolve that before rejecting.");
    }
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
    include: {
      cycle: { select: { decisionsReleasedAt: true, track: true } },
      acceptances: { select: { emailedAt: true, contract: { select: { id: true } } } },
    },
  });
  if (!app) throw new RoutingError("Application not found.");
  if (app.status !== "SUBMITTED") throw new RoutingError("This application hasn't been submitted yet.");
  if (app.cycle.track !== "VOLUNTEER") throw new RoutingError("Routing applies to volunteer cycles.");
  if (app.decision === "PENDING") throw new RoutingError("This application has no decision to reopen.");
  if (app.cycle.decisionsReleasedAt) throw new AcceptanceError("Decisions were already released; reopening is blocked.");
  // An emailed acceptance or an onboarding contract must be torn down first (mirrors
  // rejectApplication): reopening under it would leave the applicant emailed-accepted,
  // or cascade-destroy onboarding data.
  if (app.acceptances.some((a) => a.emailedAt != null || a.contract != null)) {
    throw new AcceptanceError("This applicant has an emailed acceptance or onboarding contract. Resolve that before reopening.");
  }
  const updated = await prisma.$transaction(async (tx) => {
    // A reversible reopen must not leave a live acceptance behind, or releaseDecisions
    // would later email it. The guard above read acceptances outside this tx; re-check
    // inside after dropping the not-emailed ones so a concurrently-emailed acceptance
    // aborts the reopen instead of coexisting with a PENDING decision.
    await tx.acceptance.deleteMany({ where: { applicationId, emailedAt: null } });
    if ((await tx.acceptance.count({ where: { applicationId } })) > 0) {
      throw new AcceptanceError("This applicant has an emailed acceptance or onboarding contract. Resolve that before reopening.");
    }
    return tx.application.update({
      where: { id: applicationId },
      data: { decision: "PENDING", decidedById: null, decidedAt: null, decisionNotes: null },
    });
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.application_reopen", entityType: "Application", entityId: applicationId, before: { decision: app.decision }, after: { decision: "PENDING" } });
  return updated;
}

export type BatchResult = { applied: number; skipped: { applicationId: string; reason: string }[] };

/** Batch-route a set of applications (speed-route "apply top tier"). Reuses
 *  routeApplication per row so guards never drift; a row that fails a guard is
 *  skipped with its reason rather than aborting the batch. Permission is checked
 *  once up front so a non-lead fails fast. */
export async function applyTierRoutes(
  entries: { applicationId: string; departmentCode: string }[],
  actorId: string,
): Promise<BatchResult> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't route applications.");
  }
  const skipped: { applicationId: string; reason: string }[] = [];
  let applied = 0;
  for (const e of entries) {
    try {
      await routeApplication(e.applicationId, e.departmentCode, actorId);
      applied += 1;
    } catch (err) {
      if (err instanceof RoutingError || err instanceof AcceptanceError || err instanceof RecruitmentAuthError) {
        skipped.push({ applicationId: e.applicationId, reason: err.message });
      } else throw err;
    }
  }
  return { applied, skipped };
}

/** Batch-reject a set of applications (speed-route "apply bottom tier"). Reuses
 *  rejectApplication per row with the same skip-with-reason semantics. */
export async function applyTierRejects(
  applicationIds: string[],
  actorId: string,
  notes: string | null,
): Promise<BatchResult> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't reject applications.");
  }
  const skipped: { applicationId: string; reason: string }[] = [];
  let applied = 0;
  for (const id of applicationIds) {
    try {
      await rejectApplication(id, actorId, notes);
      applied += 1;
    } catch (err) {
      if (err instanceof RoutingError || err instanceof AcceptanceError || err instanceof RecruitmentAuthError) {
        skipped.push({ applicationId: id, reason: err.message });
      } else throw err;
    }
  }
  return { applied, skipped };
}
