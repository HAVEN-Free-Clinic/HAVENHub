export type ApplicationStage =
  | "AWAITING_SCORING"
  | "SCORING"
  | "RETURNED"
  | "ROUTED"
  | "INTERVIEWING"
  | "DECIDED";

/** Derived pipeline stage. `status` on Application stays DRAFT|SUBMITTED; the
 *  stage is computed from committee scores, the routed department, the returned
 *  marker, and the application's interviews. */
export function applicationStage(input: {
  scoreCount: number;
  routedDepartmentCode: string | null;
  /** Set while a department has declined and the lead has not re-routed yet. */
  returnedToRoutingAt?: Date | null;
  applicationDecision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST";
  interviews: { decision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST" }[];
}): ApplicationStage {
  // Volunteer apps are decided directly (Application.decision, no interview);
  // director apps are decided on an Interview.
  if (input.applicationDecision !== "PENDING" || input.interviews.some((i) => i.decision !== "PENDING")) return "DECIDED";
  if (input.interviews.length > 0) return "INTERVIEWING";
  if (input.routedDepartmentCode) return "ROUTED";
  // Checked after ROUTED so a re-routed application reads as ROUTED even if a
  // caller passes a stale returned marker. routeApplication clears the marker,
  // so in practice the two are never both set.
  if (input.returnedToRoutingAt) return "RETURNED";
  if (input.scoreCount > 0) return "SCORING";
  return "AWAITING_SCORING";
}

export const applicationStageLabel: Record<ApplicationStage, string> = {
  AWAITING_SCORING: "Awaiting scoring",
  SCORING: "Scoring",
  RETURNED: "Needs re-routing",
  ROUTED: "Routed",
  INTERVIEWING: "Interviewing",
  DECIDED: "Decided",
};

/** Pipeline order, used to sort the roster by stage. The index is the stage's
 *  position in the recruitment process, so a stage-sorted roster groups the way
 *  the process actually runs rather than alphabetically.
 *
 *  RETURNED sits just before ROUTED: a returned application is scored and
 *  waiting on the same lead action (routing) that a freshly-scored one is, so it
 *  belongs next to that work rather than filed at the end with DECIDED. */
export const APPLICATION_STAGE_ORDER: readonly ApplicationStage[] = [
  "AWAITING_SCORING",
  "SCORING",
  "RETURNED",
  "ROUTED",
  "INTERVIEWING",
  "DECIDED",
];
