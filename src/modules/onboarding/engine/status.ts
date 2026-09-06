import type { ComplianceStatus, TrainingState } from "@/platform/compliance/rules";

/**
 * Both types now live in platform so `my-info`, `volunteers` and
 * `platform/email` can name them without a module importing a module. Re-exported
 * here because this engine is where they are derived and where most callers
 * already look for them.
 */
export type { OnboardingTaskKey, OnboardingTaskState } from "@/platform/compliance/task-state";

import type { OnboardingTaskState } from "@/platform/compliance/task-state";

function present(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** Profile is complete when the core contact identity editable in /my-info is filled. */
export function deriveProfileTaskState(p: { contactEmail: string | null; phone: string | null }): OnboardingTaskState {
  return present(p.contactEmail) && present(p.phone) ? "COMPLETE" : "INCOMPLETE";
}

/** A HIPAA cert that is valid today (compliant or merely expiring soon) clears the task.
 *  A cert that is on file but waiting on a compliance manager reads as in progress: the
 *  member has done their part and re-uploading would not help. IN_PROGRESS still fails
 *  isSatisfied, so the gate is unchanged; only what the member is told changes. */
export function deriveHipaaTaskState(status: ComplianceStatus): OnboardingTaskState {
  if (status === "COMPLIANT" || status === "EXPIRING_SOON") return "COMPLETE";
  if (status === "PENDING_VERIFICATION" || status === "UNKNOWN_DATE") return "IN_PROGRESS";
  return "INCOMPLETE";
}

/** Training is complete when passed; a started-but-unpassed attempt reads as in progress.
 *  Only called for tracks the person is actually required to complete. */
export function deriveTrainingTaskState(t: { state: TrainingState; attemptsUsed: number }): OnboardingTaskState {
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

/** EHS clears when every active EHS training is complete; none active means not required. */
export function deriveEhsTaskState(items: { complete: boolean }[]): OnboardingTaskState {
  if (items.length === 0) return "NOT_REQUIRED";
  if (items.every((i) => i.complete)) return "COMPLETE";
  if (items.some((i) => i.complete)) return "IN_PROGRESS";
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

/** Split the two gating decisions: `onboarded` (blocking tasks only, drives the
 *  app gate) vs `cleared` (all tasks incl non-blocking EHS, drives the clearance card). */
export function computeGating(
  tasks: { state: OnboardingTaskState; blocking: boolean }[]
): { onboarded: boolean; cleared: boolean } {
  const onboarded = tasks.filter((t) => t.blocking).every((t) => isSatisfied(t.state));
  const cleared = tasks.every((t) => isSatisfied(t.state));
  return { onboarded, cleared };
}
