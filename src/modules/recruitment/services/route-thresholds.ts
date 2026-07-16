import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";

export class RouteThresholdError extends Error {
  constructor(message: string) { super(message); this.name = "RouteThresholdError"; }
}

/** Save a cycle's speed-route percentile thresholds. review_all only. Validates
 *  each percent as a whole number in 0..100 and top + bottom <= 100 (the middle
 *  tier is the remainder). No email or applicant-visible change. */
export async function setRouteThresholds(
  cycleId: string,
  topPercent: number,
  bottomPercent: number,
  actorId: string,
): Promise<void> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't change routing thresholds.");
  }
  for (const [label, v] of [["Top", topPercent], ["Bottom", bottomPercent]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 100) {
      throw new RouteThresholdError(`${label} percent must be a whole number from 0 to 100.`);
    }
  }
  if (topPercent + bottomPercent > 100) {
    throw new RouteThresholdError("Top and bottom percentages can't add up to more than 100.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { id: true } });
  if (!cycle) throw new RouteThresholdError("Cycle not found.");
  await prisma.recruitmentCycle.update({ where: { id: cycleId }, data: { routeTopPercent: topPercent, routeBottomPercent: bottomPercent } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.route_thresholds", entityType: "RecruitmentCycle", entityId: cycleId, after: { topPercent, bottomPercent } });
}
