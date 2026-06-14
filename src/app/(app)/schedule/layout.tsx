import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function ScheduleLayout({ children }: { children: ReactNode }) {
  await requireModuleAccess("schedule");
  const mod = getModule("schedule")!;
  return (
    <>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </>
  );
}
