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
  const updated = await prisma.application.update({
    where: { id: applicationId },
    data: { routedDepartmentCode: departmentCode, routedById: actorId, routedAt: new Date() },
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.route", entityType: "Application", entityId: applicationId, after: { departmentCode } });
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
      data: { decision: outcome, decidedById: deciderId, decidedAt: new Date() },
    });
  });
  await recordAudit({ actorPersonId: deciderId, action: "recruitment.application_decide", entityType: "Application", entityId: applicationId, after: { decision: outcome, departmentCode } });
  return updated;
}
