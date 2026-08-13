import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { canManageAnyScheduleDept } from "@/modules/schedule/services/builder";
import { canManageAttendings } from "@/modules/schedule/services/attendings";
import { manageableRequestDepartmentIds } from "@/modules/schedule/services/requests";
import { isClinicDayToday } from "@/modules/schedule/services/attendance";
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
// Check in is a fourth, differently-shaped case: it's not a per-person capability
// but a calendar fact, "is today a clinic day" -- resolved by isClinicDayToday,
// the same service that owns every other check-in decision. Shown to everyone
// once true, since anyone with module access can check themselves in.
//
// All four carry `dynamicGate: true` in the registry, which keeps them out of
// the *global* nav's Schedule dropdown (it cannot run these checks). This layout
// remains the only place that decides whether they appear in the tab row.
const BUILDER_HREF = "/schedule/builder";
const ATTENDINGS_HREF = "/schedule/attendings";
const APPROVALS_HREF = "/schedule/requests";
const CHECK_IN_HREF = "/schedule/check-in";

export default async function ScheduleLayout({ children }: { children: ReactNode }) {
  const { personId } = await requireModuleAccess("schedule");
  const mod = getModule("schedule")!;
  const [canBuild, managesAttendings, requestDeptIds, isClinicDay] = await Promise.all([
    canManageAnyScheduleDept(personId),
    canManageAttendings(personId),
    manageableRequestDepartmentIds(personId),
    isClinicDayToday(),
  ]);
  const canApprove = requestDeptIds.length > 0;
  // Attendings is a management tool: it maintains the roster and books who
  // covers each clinic date, which Faculty Relations does. What a VOLUNTEER
  // needs from it -- who is attending on the shift they are working -- is on
  // their own schedule page instead (see MyShift.attendings), scoped to the
  // dates they actually work rather than the whole term.
  const items = mod.nav.filter(
    (item) =>
      (item.href !== BUILDER_HREF || canBuild) &&
      (item.href !== ATTENDINGS_HREF || managesAttendings) &&
      (item.href !== APPROVALS_HREF || canApprove) &&
      (item.href !== CHECK_IN_HREF || isClinicDay),
  );
  return (
    <>
      <ModuleNav items={items} />
      <div className="mt-8">{children}</div>
    </>
  );
}
