import type { Decision } from "./decision-summary";

/**
 * Director-track departments can decide an applicant two ways: hold an
 * interview and decide it, or decide without extending one. Both land on the
 * same Interview row, so acceptances, release, the decision emails, the
 * waitlist, and conflict checks all read one place. What tells them apart is
 * derived, not stored:
 *
 * - no interview time was ever set (scheduledAt is null), and
 * - no panelist has evaluated.
 *
 * decideWithoutInterview refuses a row that already has a time, an invite, or
 * an evaluation, and updateInterview refuses to put a time on a row decided
 * this way, so a decided row with neither is exactly one that skipped the
 * interview. A row with neither that is still PENDING is just an interview
 * nobody has scheduled yet.
 */
export function isDecidedWithoutInterview(iv: {
  decision: Decision;
  scheduledAt: Date | null;
  evaluationCount: number;
}): boolean {
  return iv.decision !== "PENDING" && iv.scheduledAt == null && iv.evaluationCount === 0;
}

/**
 * Is an interview under way for this row: a time set, an invite sent, or a
 * panelist's evaluation in? Once it is, the decision belongs on the interview
 * page with the panel's evaluations, not on the decide-without-interview form.
 */
export function isInterviewUnderWay(iv: {
  scheduledAt: Date | null;
  invitedAt: Date | null;
  evaluationCount: number;
}): boolean {
  return iv.scheduledAt != null || iv.invitedAt != null || iv.evaluationCount > 0;
}

/**
 * The departments a director-track applicant asked to be considered by: the
 * ones they ranked, plus the department a renewal is renewing in (submission
 * already folds that into departmentChoices, so this only guards older rows).
 * Limited to the cycle's departments, in ranked order, without repeats.
 */
export function rankedDirectorDepartments(
  app: { departmentChoices: string[]; renewalDepartment: string | null },
  cycleDepartments: string[],
): string[] {
  const ranked = [...app.departmentChoices, ...(app.renewalDepartment ? [app.renewalDepartment] : [])];
  return [...new Set(ranked)].filter((d) => cycleDepartments.includes(d));
}
