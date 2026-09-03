/**
 * Which department an applicant row belongs to, for the roster's Department
 * filter.
 *
 * Routing is the assignment that counts once it has happened: a routed
 * application is that department's to decide, whatever the applicant ranked.
 * Routing off the ranked choices is a real case the detail page already flags
 * (routedOffChoice), so "routed to PCAR, ranked SCTP" must answer for PCAR and
 * not for SCTP -- SCTP will never see it again.
 *
 * Before routing there is no assignment, so the ranked choices are the only
 * department signal the row carries and it answers for every department it
 * ranked. Director-track cycles have no routing stage at all, so they always
 * take this branch.
 *
 * That split is exactly the one listApplicantsForReview uses to scope a
 * director's queue, so filtering by a department can never surface a row that
 * department would not end up owning.
 */

export type DepartmentedApplicant = {
  routedDepartmentCode: string | null;
  departmentChoices: string[];
};

/** The department codes a row answers for. */
export function applicantDepartments(a: DepartmentedApplicant): string[] {
  return a.routedDepartmentCode ? [a.routedDepartmentCode] : a.departmentChoices;
}

/**
 * The dropdown's options: every department code present in the roster, deduped
 * and sorted.
 *
 * Derived from the rows the viewer can actually see rather than from the
 * cycle's `departments` list, so every option returns at least one row. A
 * scoped director's cycle lists departments they cannot review, and offering
 * those would be a menu of dead ends.
 */
export function departmentFilterOptions(apps: DepartmentedApplicant[]): string[] {
  return [...new Set(apps.flatMap(applicantDepartments))].sort();
}

/** Narrows a roster to one department. A null code means no filter. */
export function filterApplicantsByDepartment<T extends DepartmentedApplicant>(
  apps: T[],
  code: string | null,
): T[] {
  if (!code) return apps;
  return apps.filter((a) => applicantDepartments(a).includes(code));
}
