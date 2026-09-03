import type { ReactNode } from "react";
import { requirePersonSession } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { getModule } from "@/platform/modules/registry";
import { canAccessModule, filterNavItems } from "@/platform/modules/access";
import { isInterviewPanelist } from "@/modules/recruitment/services/interviews";
import { reviewScope } from "@/modules/recruitment/services/review";
import { canRecordAttendance } from "@/modules/recruitment/services/attendance-events";
import { recruitmentNavItems, EVENTS_HREF } from "@/modules/recruitment/nav";
import { ModuleNav } from "@/platform/ui/module-nav";
import { moduleMetadata } from "@/platform/branding/metadata";

export function generateMetadata() {
  return moduleMetadata("recruitment");
}

export default async function RecruitmentLayout({ children }: { children: ReactNode }) {
  // The recruitment area is open to a bare session so interview panelists (who
  // are not recruitment staff and hold no recruitment.access) can reach
  // /recruitment/interviews/**. recruitment.access is enforced on the staff
  // surfaces themselves: the cycles subtree layout (/recruitment/cycles/**) and
  // the cycles index page (/recruitment).
  //
  // The nav is assembled per viewer: staff get the module's (permission-filtered)
  // staff tabs; anyone on an interview panel additionally gets a "My interviews"
  // tab. Panel membership is dynamic, not a permission, so it cannot flow through
  // the registry's permission-based filterNavItems and is resolved here.
  const person = await requirePersonSession();
  const mod = getModule("recruitment")!;
  const [perms, isPanelist, scope, canTakeAttendance] = await Promise.all([
    getEffectivePermissions(person.personId),
    isInterviewPanelist(person.personId),
    reviewScope(person.personId),
    canRecordAttendance(person.personId),
  ]);
  // A department director is a recruitment reviewer by scope (manageableDepartmentIds),
  // not by a recruitment permission, so canAccessModule misses them. Treat a scope
  // reviewer as staff-eligible so the Cycles nav renders -- they can already open the
  // applications routed to their department, this just gives them a way to navigate.
  const isStaff = canAccessModule(mod, perms) || scope.all || scope.departmentCodes.length > 0;
  // Permission gate first, then the data-driven one, exactly like the schedule
  // module's tabs: Events is open to anyone who may record attendance on ANY
  // scope, which includes a department director admitted by review scope alone
  // and holding no recruitment permission at all. That is why the registry marks
  // it dynamicGate and the check lands here.
  const staffNav = isStaff
    ? filterNavItems(mod.nav, perms).filter(
        (item) => item.href !== EVENTS_HREF || canTakeAttendance,
      )
    : [];
  const items = recruitmentNavItems({ staffNav, isPanelist });
  return (
    <>
      {items.length > 0 && <ModuleNav items={items} />}
      <div className="mt-8">{children}</div>
    </>
  );
}
