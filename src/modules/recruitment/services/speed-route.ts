import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { RecruitmentAuthError } from "./review";
import { RoutingError } from "./routing";
import { scoreAverage } from "../engine/scoring";
import { bucketByPercentile } from "../engine/route-buckets";
import { applicationStage, type ApplicationStage } from "../engine/application-stage";

export type SpeedRouteRow = {
  applicationId: string;
  name: string;
  average: number | null;
  scoreCount: number;
  departmentChoices: string[];
  proposedDepartmentCode: string | null; // departmentChoices[0] if it is a cycle department, else null
  routedDepartmentCode: string | null;
  decision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST";
  stage: ApplicationStage;
  acceptanceEmailed: boolean;
};

export type SpeedRouteBoard = {
  cycleId: string;
  title: string;
  track: string;
  departments: string[];
  topPercent: number;
  bottomPercent: number;
  top: SpeedRouteRow[];
  middle: SpeedRouteRow[];
  bottom: SpeedRouteRow[];
  unscored: SpeedRouteRow[];
};

/** Assemble the speed-route board: every SUBMITTED application bucketed by
 *  committee average into top/middle/bottom (unscored listed apart), each row
 *  carrying its current routing/decision state and a proposed department. */
export async function loadSpeedRouteBoard(cycleId: string, viewerId: string): Promise<SpeedRouteBoard> {
  if (!(await can(viewerId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't route applications.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id: cycleId },
    select: { id: true, title: true, track: true, departments: true, routeTopPercent: true, routeBottomPercent: true },
  });
  if (!cycle) throw new RoutingError("Cycle not found.");
  if (cycle.track !== "VOLUNTEER") throw new RoutingError("Speed route applies to volunteer cycles.");

  const apps = await prisma.application.findMany({
    where: { cycleId, status: "SUBMITTED" },
    include: {
      applicant: { select: { firstName: true, lastName: true } },
      committeeScores: { select: { score: true } },
      acceptances: { select: { emailedAt: true } },
      interviews: { select: { decision: true } },
    },
  });

  const deptSet = new Set(cycle.departments);
  const byId = new Map<string, SpeedRouteRow>();
  const bucketItems = apps.map((a) => {
    const { average, count } = scoreAverage(a.committeeScores.map((s) => s.score));
    const first = a.departmentChoices[0] ?? null;
    const row: SpeedRouteRow = {
      applicationId: a.id,
      name: `${a.applicant.firstName} ${a.applicant.lastName}`,
      average,
      scoreCount: count,
      departmentChoices: a.departmentChoices,
      proposedDepartmentCode: first && deptSet.has(first) ? first : null,
      routedDepartmentCode: a.routedDepartmentCode,
      decision: a.decision,
      stage: applicationStage({
        scoreCount: a.committeeScores.length,
        routedDepartmentCode: a.routedDepartmentCode,
        applicationDecision: a.decision,
        interviews: a.interviews,
      }),
      acceptanceEmailed: a.acceptances.some((x) => x.emailedAt != null),
    };
    byId.set(a.id, row);
    return { applicationId: a.id, average };
  });

  const buckets = bucketByPercentile({
    items: bucketItems,
    topPercent: cycle.routeTopPercent,
    bottomPercent: cycle.routeBottomPercent,
  });
  const rows = (ids: string[]) => ids.map((id) => byId.get(id)!);
  return {
    cycleId: cycle.id,
    title: cycle.title,
    track: cycle.track,
    departments: cycle.departments,
    topPercent: cycle.routeTopPercent,
    bottomPercent: cycle.routeBottomPercent,
    top: rows(buckets.top),
    middle: rows(buckets.middle),
    bottom: rows(buckets.bottom),
    unscored: rows(buckets.unscored),
  };
}
