/**
 * Which schedule tabs a given viewer can actually open.
 *
 * Five schedule tabs gate on a data-driven capability that no permission string
 * can express -- managing a schedule department, managing an RHD department,
 * having any request department to approve for -- so they carry `dynamicGate`
 * in the registry, and the global nav drops them rather than offer a link that
 * bounces to /no-access.
 *
 * That left them reachable from nowhere but the schedule tab row itself. A
 * department director whose whole job is the Builder could not get to it from
 * the toolbar or from Cmd+K: they had to land on /schedule first and find the
 * tab. This resolves the gates once, so the global nav and the palette can
 * offer exactly the tabs the tab row would.
 *
 * ## Cost
 *
 * Every one of these funnels into `getEffectivePermissions` /
 * `permissionDepartmentIds`, which share one request-cached
 * `loadAssignmentContext` read. The app layout already loads that context to
 * build the nav at all, so resolving these adds no database round trip.
 *
 * ## Why Check in is not here
 *
 * "Is today a clinic day, and does this viewer have a volunteer shift on it"
 * needs three more queries (isClinicDayToday, attendingForPerson,
 * hasVolunteerShiftToday) that the assignment context does NOT cover, on every
 * page in the app, to decide a tab that is meaningful on roughly 30 days a
 * year. The schedule layout keeps deciding that one.
 */

import { canManageAnyScheduleDept } from "./services/builder";
import { canManageAttendings, canViewAttendingCoverage } from "./services/attendings";
import { manageableRequestDepartmentIds } from "./services/requests";

export const SCHEDULE_BUILDER_HREF = "/schedule/builder";
export const SCHEDULE_ATTENDINGS_HREF = "/schedule/attendings";
export const SCHEDULE_CREDENTIALING_HREF = "/schedule/attendings/credentialing";
export const SCHEDULE_COVERAGE_HREF = "/schedule/coverage";
export const SCHEDULE_APPROVALS_HREF = "/schedule/requests";

/** The dynamically-gated schedule hrefs this person may open. */
export async function resolvedScheduleNavHrefs(personId: string): Promise<Set<string>> {
  const [canBuild, managesAttendings, viewsCoverage, requestDeptIds] = await Promise.all([
    canManageAnyScheduleDept(personId),
    canManageAttendings(personId),
    canViewAttendingCoverage(personId),
    manageableRequestDepartmentIds(personId),
  ]);
  // Mirror requests/page.tsx exactly: EITHER authority admits. Faculty Relations
  // manages no department but decides every attending request.
  const canApprove = requestDeptIds.length > 0 || managesAttendings;

  const hrefs = new Set<string>();
  if (canBuild) hrefs.add(SCHEDULE_BUILDER_HREF);
  if (managesAttendings) {
    hrefs.add(SCHEDULE_ATTENDINGS_HREF);
    hrefs.add(SCHEDULE_CREDENTIALING_HREF);
  }
  if (viewsCoverage) hrefs.add(SCHEDULE_COVERAGE_HREF);
  if (canApprove) hrefs.add(SCHEDULE_APPROVALS_HREF);
  return hrefs;
}
