import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { canManageAnyScheduleDept } from "@/modules/schedule/services/builder";
import { ModuleNav } from "@/platform/ui/module-nav";

// The Builder tab is a management tool. Unlike the other schedule sub-tabs
// (which gate on schedule.view = module access), "can build" is a data-driven
// capability (manages a schedule department), so it can't be a registry
// permission string -- we resolve it here and drop the tab for non-managers,
// matching the page gate in builder/page.tsx.
const BUILDER_HREF = "/schedule/builder";

export default async function ScheduleLayout({ children }: { children: ReactNode }) {
  const { personId } = await requireModuleAccess("schedule");
  const mod = getModule("schedule")!;
  const canBuild = await canManageAnyScheduleDept(personId);
  const items = canBuild ? mod.nav : mod.nav.filter((item) => item.href !== BUILDER_HREF);
  return (
    <>
      <ModuleNav items={items} />
      <div className="mt-8">{children}</div>
    </>
  );
}
