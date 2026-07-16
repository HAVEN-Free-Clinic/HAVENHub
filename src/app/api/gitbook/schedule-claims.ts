import { canManageAnyScheduleDept } from "@/modules/schedule/services/builder";
import { canManageAnyRhdDept } from "@/modules/schedule/services/attendings";

/**
 * The two data-driven adaptive `can.schedule.*` leaves gate the schedule
 * Builder/Attendings docs. They derive from schedule module services rather than
 * a permission string, so they are resolved here in the app layer (which may
 * import module code) and passed into mintVisitorToken. Platform code must not
 * import module code (eslint boundary), so this computation cannot live in
 * src/platform/gitbook/visitor-token.ts.
 */
export async function scheduleDerivedClaims(
  personId: string
): Promise<Record<string, boolean>> {
  const [managesAnyScheduleDept, managesAnyRhdDept] = await Promise.all([
    canManageAnyScheduleDept(personId),
    canManageAnyRhdDept(personId),
  ]);
  return {
    "schedule.manages_any_dept": managesAnyScheduleDept,
    "schedule.manages_any_rhd_dept": managesAnyRhdDept,
  };
}
