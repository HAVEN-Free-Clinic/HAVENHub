/**
 * Dual appointments: the rules for when one application may hold acceptances
 * from two departments. Pure, so the decisions, onboarding, promotion and
 * applicant roster surfaces all read the same answer.
 *
 * Two acceptances on one application used to be an error state without
 * exception (see conflicts.ts). An APPROVED DualAppointment for a department
 * makes that department's acceptance intended: the applicant serves in the
 * department their application routes to AND that one. Anything beyond that
 * (two acceptances with no approval, or a third department) is still a
 * conflict SRR has to resolve.
 */

export type DualAppointmentStatus = "PENDING" | "APPROVED" | "DECLINED" | "CANCELLED";

/** The statuses that hold an application's one dual-appointment slot. */
export const ACTIVE_DUAL_APPOINTMENT_STATUSES: readonly DualAppointmentStatus[] = ["PENDING", "APPROVED"];

/** Most departments one person can be accepted into through one application. */
export const MAX_APPOINTED_DEPARTMENTS = 2;

/**
 * Whether an application's acceptances are a conflict, given the departments
 * approved as its dual appointment.
 *
 * A conflict is more than one accepted department that is NOT an approved dual
 * appointment, or more departments than a dual appointment allows at all. So a
 * routed department plus its approved second department is fine, an approved
 * second department on its own is simply an acceptance, and two departments
 * with no approval are the conflict they always were.
 */
export function isAcceptanceConflict(
  acceptedDepartmentCodes: readonly string[],
  approvedDualCodes: readonly string[],
): boolean {
  const accepted = [...new Set(acceptedDepartmentCodes)];
  if (accepted.length > MAX_APPOINTED_DEPARTMENTS) return true;
  const approved = new Set(approvedDualCodes);
  return accepted.filter((code) => !approved.has(code)).length > 1;
}

/**
 * The acceptance an application onboards through when it holds more than one.
 *
 * One person fills in one onboarding form, so an application accepted by two
 * departments gets one contract, and promoting it puts them on both rosters.
 * The anchor is the acceptance that already has a contract, else the routed
 * department's (the one that is not a dual appointment), else the first.
 * Every other acceptance on the application is carried by the anchor.
 */
export function onboardingAnchor<T extends { departmentCode: string; hasContract: boolean }>(
  acceptances: readonly T[],
  approvedDualCodes: readonly string[],
): T | null {
  if (acceptances.length === 0) return null;
  const withContract = acceptances.find((a) => a.hasContract);
  if (withContract) return withContract;
  const approved = new Set(approvedDualCodes);
  return acceptances.find((a) => !approved.has(a.departmentCode)) ?? acceptances[0];
}

/** "A", "A and B", "A, B and C": department names as a sentence reads them. */
export function joinNames(names: readonly string[]): string {
  const unique = [...new Set(names.filter((n) => n.trim() !== ""))];
  if (unique.length <= 1) return unique[0] ?? "";
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}
