export type ApplicationStage =
  | "AWAITING_SCORING"
  | "SCORING"
  | "ROUTED"
  | "INTERVIEWING"
  | "DECIDED";

/** Derived pipeline stage. `status` on Application stays DRAFT|SUBMITTED; the
 *  stage is computed from committee scores, the routed department, and the
 *  application's interviews. */
export function applicationStage(input: {
  scoreCount: number;
  routedDepartmentCode: string | null;
  interviews: { decision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST" }[];
}): ApplicationStage {
  if (input.interviews.some((i) => i.decision !== "PENDING")) return "DECIDED";
  if (input.interviews.length > 0) return "INTERVIEWING";
  if (input.routedDepartmentCode) return "ROUTED";
  if (input.scoreCount > 0) return "SCORING";
  return "AWAITING_SCORING";
}

export const applicationStageLabel: Record<ApplicationStage, string> = {
  AWAITING_SCORING: "Awaiting scoring",
  SCORING: "Scoring",
  ROUTED: "Routed",
  INTERVIEWING: "Interviewing",
  DECIDED: "Decided",
};
