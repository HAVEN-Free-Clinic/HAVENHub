import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { canManageAnyScheduleDept } from "@/modules/schedule/services/builder";
import { canManageAttendings, canViewAttendingCoverage } from "@/modules/schedule/services/attendings";
import { manageableRequestDepartmentIds } from "@/modules/schedule/services/requests";
import { isClinicDayToday, hasVolunteerShiftToday } from "@/modules/schedule/services/attendance";
import { attendingForPerson } from "@/modules/schedule/services/attending-portal";
import { filterNavItems } from "@/platform/modules/access";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { ModuleNav } from "@/platform/ui/module-nav";
import { moduleMetadata } from "@/platform/branding/metadata";

export function generateMetadata() {
  return moduleMetadata("schedule");
}

// Builder and Attendings are management tools. Unlike the other schedule
// sub-tabs (which gate on schedule.view = module access), their access is a
// data-driven capability -- managing a schedule department (Builder) or an
// RHD-family department (Attendings) -- so it can't be a registry permission
// string. We resolve it here and drop the tab for non-managers, matching the
// page gates in builder/page.tsx and attendings/page.tsx.
//
// Approvals is the same shape: /schedule/requests admits only viewers whose
// manageableRequestDepartmentIds set is non-empty (its registry `permission`
// string schedule.manage_requests is necessary but not sufficient -- a holder
// who manages no department is still bounced to /no-access). ModuleNav does not
// enforce per-item permissions, so resolve the page's exact gate here and drop
// the tab when the viewer can approve nothing.
//
// Check in is a fourth, differently-shaped case: mostly a calendar fact, "is
// today a clinic day" -- resolved by isClinicDayToday, the same service that owns
// every other check-in decision. Shown to everyone once true, since anyone with
// module access can check themselves in, EXCEPT an attending-only viewer: check-in
// is keyed on a volunteer ShiftAssignment they will never have. See below.
//
// All four carry `dynamicGate: true` in the registry, which keeps them out of
// the *global* nav's Schedule dropdown (it cannot run these checks). This layout
// remains the only place that decides whether they appear in the tab row.
//
// Tabs gated on a plain `permission` are NOT in this list. They are handled by
// filterNavItems below, the same helper the other six module layouts use.
//
// This layout used to filter mod.nav by href alone, which made the href list
// load-bearing for permission tabs too: one that nobody remembered to add was
// shown to every schedule.view holder, and every seeded volunteer role holds
// schedule.view, so it was a link straight to /no-access. Adding Specialties
// surfaced that, and the answer is for the list to stop being exhaustive rather
// than to keep remembering to extend it. Only add an href here when the gate is
// something no permission string can express.
const BUILDER_HREF = "/schedule/builder";
const ATTENDINGS_HREF = "/schedule/attendings";
const COVERAGE_HREF = "/schedule/coverage";
const APPROVALS_HREF = "/schedule/requests";
const CHECK_IN_HREF = "/schedule/check-in";

export default async function ScheduleLayout({ children }: { children: ReactNode }) {
  const { personId } = await requireModuleAccess("schedule");
  const mod = getModule("schedule")!;
  const [canBuild, managesAttendings, viewsCoverage, requestDeptIds, isClinicDay, perms, linkedAttending] =
    await Promise.all([
      canManageAnyScheduleDept(personId),
      canManageAttendings(personId),
      canViewAttendingCoverage(personId),
      manageableRequestDepartmentIds(personId),
      isClinicDayToday(),
      getEffectivePermissions(personId),
      attendingForPerson(personId),
    ]);
  // Mirror the page's own gate exactly (requests/page.tsx): EITHER authority
  // admits. Faculty Relations manages no department but decides every attending
  // request, so a department-only check dropped the tab for the one person the
  // attending-request emails send here.
  const canApprove = requestDeptIds.length > 0 || managesAttendings;

  // Check in records VOLUNTEER shift attendance, keyed on a ShiftAssignment. An
  // attending has none, so checkInSelf answers NOT_ASSIGNED for them every time
  // -- on the very Saturday they are covering, which is the worst moment to be
  // told you are not scheduled. Drop the tab rather than ship that dead end.
  //
  // "Attending-only", not "attending": someone who is both faculty and a
  // volunteer has real assignments and keeps the tab. Their volunteer shifts are
  // the thing being checked in for.
  const attendingOnly = linkedAttending !== null && !(await hasVolunteerShiftToday(personId));
  // Attendings is a management tool: it maintains the roster and books who
  // covers each clinic date, which Faculty Relations does. What a VOLUNTEER
  // needs from it -- who is attending on the shift they are working -- is on
  // their own schedule page instead (see MyShift.attendings), scoped to the
  // dates they actually work rather than the whole term.
  // Coverage is the read-only twin of Attendings, on a WIDER gate: Faculty
  // Relations builds the schedule, but everyone holding clinic-wide schedule
  // rights runs a clinic day and has to be able to look coverage up.
  // Permission gates first, then the data-driven ones. Both apply: Approvals
  // carries a permission AND a department check, and narrowing twice is right.
  const items = filterNavItems(mod.nav, perms).filter(
    (item) =>
      (item.href !== BUILDER_HREF || canBuild) &&
      (item.href !== ATTENDINGS_HREF || managesAttendings) &&
      (item.href !== COVERAGE_HREF || viewsCoverage) &&
      (item.href !== APPROVALS_HREF || canApprove) &&
      (item.href !== CHECK_IN_HREF || (isClinicDay && !attendingOnly)),
  );
  return (
    <>
      <ModuleNav items={items} />
      <div className="mt-8">{children}</div>
    </>
  );
}
