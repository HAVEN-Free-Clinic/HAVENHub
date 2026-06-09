/** Given (applicationId, departmentCode) acceptance pairs, return the set of
 *  applicationIds accepted by MORE THAN ONE distinct department -- the conflicts
 *  SRR must resolve before those applicants can be notified. Pure. */
export function findAcceptanceConflicts(
  acceptances: { applicationId: string; departmentCode: string }[]
): Set<string> {
  const byApp = new Map<string, Set<string>>();
  for (const a of acceptances) {
    const set = byApp.get(a.applicationId) ?? new Set<string>();
    set.add(a.departmentCode);
    byApp.set(a.applicationId, set);
  }
  const conflicts = new Set<string>();
  for (const [applicationId, departments] of byApp) {
    if (departments.size > 1) conflicts.add(applicationId);
  }
  return conflicts;
}
