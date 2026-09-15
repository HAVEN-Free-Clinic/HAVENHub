import { isAcceptanceConflict } from "./dual-appointments";

/** Given (applicationId, departmentCode) acceptance pairs, return the set of
 *  applicationIds accepted by more departments than they are allowed -- the
 *  conflicts SRR must resolve before those applicants can be notified.
 *
 *  `approvedDuals` lists each application's APPROVED dual appointments. A
 *  department covered by one is an intended second acceptance, not a conflict
 *  (see dual-appointments.ts). Omit it and any second department conflicts,
 *  which is the rule every caller had before dual appointments existed. Pure. */
export function findAcceptanceConflicts(
  acceptances: { applicationId: string; departmentCode: string }[],
  approvedDuals: { applicationId: string; departmentCode: string }[] = [],
): Set<string> {
  const byApp = new Map<string, string[]>();
  for (const a of acceptances) {
    byApp.set(a.applicationId, [...(byApp.get(a.applicationId) ?? []), a.departmentCode]);
  }
  const dualsByApp = new Map<string, string[]>();
  for (const d of approvedDuals) {
    dualsByApp.set(d.applicationId, [...(dualsByApp.get(d.applicationId) ?? []), d.departmentCode]);
  }
  const conflicts = new Set<string>();
  for (const [applicationId, departments] of byApp) {
    if (isAcceptanceConflict(departments, dualsByApp.get(applicationId) ?? [])) conflicts.add(applicationId);
  }
  return conflicts;
}
