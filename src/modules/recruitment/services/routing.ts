import type { Application } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";

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
    include: { cycle: { select: { departments: true } } },
  });
  if (!app) throw new RoutingError("Application not found.");
  if (app.status !== "SUBMITTED") throw new RoutingError("This application hasn't been submitted yet.");
  if (!app.cycle.departments.includes(departmentCode)) throw new RoutingError("That department is not part of this cycle.");
  const updated = await prisma.application.update({
    where: { id: applicationId },
    data: { routedDepartmentCode: departmentCode, routedById: actorId, routedAt: new Date() },
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.route", entityType: "Application", entityId: applicationId, after: { departmentCode } });
  return updated;
}
