import { canManageAnyScheduleDept } from "@/modules/schedule/services/builder";
import { canManageAttendings } from "@/modules/schedule/services/attendings";

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
  const [managesAnyScheduleDept, managesAnyAttendingRoster] = await Promise.all([
    canManageAnyScheduleDept(personId),
    canManageAttendings(personId),
  ]);
  return {
    "schedule.manages_any_dept": managesAnyScheduleDept,
    // KEY DELIBERATELY UNCHANGED. The service behind it was renamed away from
    // "RHD", but this leaf is a PUBLISHED contract: a live GitBook page gates on
    // `visitor.claims.can.schedule.manages_any_rhd_dept` (see
    // docs/gitbook/adaptive-mapping.md). Renaming it here without editing that
    // page's condition in GitBook first would hide the Attendings doc from
    // everyone. Rename both together, or neither.
    "schedule.manages_any_rhd_dept": managesAnyAttendingRoster,
  };
}
