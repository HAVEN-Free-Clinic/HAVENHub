import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { canManageAnyScheduleDept } from "@/modules/schedule/services/builder";
import { canManageAnyRhdDept } from "@/modules/schedule/services/attendings";
import { ModuleNav } from "@/platform/ui/module-nav";

// Builder and Attendings are management tools. Unlike the other schedule
// sub-tabs (which gate on schedule.view = module access), their access is a
// data-driven capability -- managing a schedule department (Builder) or an
// RHD-family department (Attendings) -- so it can't be a registry permission
// string. We resolve it here and drop the tab for non-managers, matching the
// page gates in builder/page.tsx and attendings/page.tsx.
const BUILDER_HREF = "/schedule/builder";
const ATTENDINGS_HREF = "/schedule/attendings";

export default async function ScheduleLayout({ children }: { children: ReactNode }) {
  const { personId } = await requireModuleAccess("schedule");
  const mod = getModule("schedule")!;
  const [canBuild, canManageAttendings] = await Promise.all([
    canManageAnyScheduleDept(personId),
    canManageAnyRhdDept(personId),
  ]);
  const items = mod.nav.filter(
    (item) =>
      (item.href !== BUILDER_HREF || canBuild) &&
      (item.href !== ATTENDINGS_HREF || canManageAttendings),
  );
  return (
    <>
      <ModuleNav items={items} />
      <div className="mt-8">{children}</div>
    </>
  );
}
