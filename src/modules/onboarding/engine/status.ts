import type { ComplianceStatus, TrainingState } from "@/platform/compliance/rules";

/** The four onboarding requirements a volunteer clears for the active term. */
export type OnboardingTaskKey = "profile" | "hipaa" | "training" | "learning";

/** Per-task resolution. NOT_REQUIRED means the task does not apply (e.g. no
 *  courses assigned) and is treated as satisfied for gating. */
export type OnboardingTaskState = "COMPLETE" | "IN_PROGRESS" | "INCOMPLETE" | "NOT_REQUIRED";

function present(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** Profile is complete when the core contact identity editable in /my-info is filled. */
export function deriveProfileTaskState(p: { contactEmail: string | null; phone: string | null }): OnboardingTaskState {
  return present(p.contactEmail) && present(p.phone) ? "COMPLETE" : "INCOMPLETE";
}

/** A HIPAA cert that is valid today (compliant or merely expiring soon) clears the task. */
export function deriveHipaaTaskState(status: ComplianceStatus): OnboardingTaskState {
  return status === "COMPLIANT" || status === "EXPIRING_SOON" ? "COMPLETE" : "INCOMPLETE";
}

/** Volunteer training only applies to active volunteers; the quiz itself rejects
 *  non-volunteers, so a director-only member is NOT_REQUIRED rather than blocked.
 *  Otherwise: complete when passed; a started-but-unpassed attempt is in progress. */
export function deriveTrainingTaskState(
  t: { state: TrainingState; attemptsUsed: number },
  isVolunteer: boolean
): OnboardingTaskState {
  if (!isVolunteer) return "NOT_REQUIRED";
  if (t.state === "COMPLETE") return "COMPLETE";
  return t.attemptsUsed > 0 ? "IN_PROGRESS" : "INCOMPLETE";
}

/** Learning clears when every assigned course is complete; none assigned means not required. */
export function deriveLearningTaskState(courses: { status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE" }[]): OnboardingTaskState {
  if (courses.length === 0) return "NOT_REQUIRED";
  if (courses.every((c) => c.status === "COMPLETE")) return "COMPLETE";
  if (courses.some((c) => c.status !== "NOT_STARTED")) return "IN_PROGRESS";
  return "INCOMPLETE";
}

/** COMPLETE and NOT_REQUIRED both satisfy the gate. */
export function isSatisfied(state: OnboardingTaskState): boolean {
  return state === "COMPLETE" || state === "NOT_REQUIRED";
}

/** Roll up task states into display counts + the overall onboarded flag. */
export function summarize(states: OnboardingTaskState[]): { completedCount: number; totalCount: number; onboarded: boolean } {
  const completedCount = states.filter(isSatisfied).length;
  return { completedCount, totalCount: states.length, onboarded: completedCount === states.length };
}
