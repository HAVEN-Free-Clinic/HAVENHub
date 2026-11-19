import { usesCommitteeScoring } from "./scoring";

export type ApplicationStage =
  | "AWAITING_SCORING"
  | "SCORING"
  | "RETURNED"
  | "ROUTED"
  | "AWAITING_INTERVIEW"
  | "INTERVIEWING"
  | "DECIDED";

/** Derived pipeline stage. `status` on Application stays DRAFT|SUBMITTED; the
 *  stage is computed from committee scores, the routed department, the returned
 *  marker, and the application's interviews.
 *
 *  Director cycles have no committee scoring (usesCommitteeScoring), so an
 *  undecided director application with no interview is AWAITING_INTERVIEW, never
 *  AWAITING_SCORING or SCORING, whatever stray committee scores it carries. */
export function applicationStage(input: {
  track: "VOLUNTEER" | "DIRECTOR";
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
  // Directors are never routed or committee-scored: until a director extends an
  // interview or records a decision, the application is waiting on them.
  if (!usesCommitteeScoring(input.track)) return "AWAITING_INTERVIEW";
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
  AWAITING_INTERVIEW: "Awaiting interview or decision",
  INTERVIEWING: "Interviewing",
  DECIDED: "Decided",
};

/** Pipeline order, used to sort the roster by stage. The index is the stage's
 *  position in the recruitment process, so a stage-sorted roster groups the way
 *  the process actually runs rather than alphabetically.
 *
 *  RETURNED sits just before ROUTED: a returned application is scored and
 *  waiting on the same lead action (routing) that a freshly-scored one is, so it
 *  belongs next to that work rather than filed at the end with DECIDED.
 *
 *  AWAITING_INTERVIEW is director-only, so it never shares a roster with the
 *  committee stages; it sits just before INTERVIEWING, the stage it leads to. */
export const APPLICATION_STAGE_ORDER: readonly ApplicationStage[] = [
  "AWAITING_SCORING",
  "SCORING",
  "RETURNED",
  "ROUTED",
  "AWAITING_INTERVIEW",
  "INTERVIEWING",
  "DECIDED",
];

/**
 * Has this application left the committee's hands?
 *
 * True once it sits with a department, is in interviews, or carries a final
 * decision. Nothing the committee does next changes any of those: a fresh
 * committee score does not un-route anyone, and the routing controls are already
 * inert on such a row. The speed surfaces use this to keep finished work out of
 * the way -- the score queue drops these applications outright, the route board
 * hides them behind a toggle.
 *
 * RETURNED is deliberately NOT handled: a department declined the applicant and
 * handed them back, so the lead still owes them a routing decision. Nor is
 * AWAITING_INTERVIEW: a director still owes it an interview or a decision. (It
 * never reaches a committee surface anyway, since director cycles are not
 * committee-scored.)
 */
export function isHandledStage(stage: ApplicationStage): boolean {
  return stage === "ROUTED" || stage === "INTERVIEWING" || stage === "DECIDED";
}
