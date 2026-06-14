import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function RecruitmentLayout({ children }: { children: ReactNode }) {
  await requireModuleAccess("recruitment");
  const mod = getModule("recruitment")!;
  return (
    <>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </>
  );
}
