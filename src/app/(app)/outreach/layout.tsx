import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { ModuleNav } from "@/platform/ui/module-nav";
import { moduleMetadata } from "@/platform/branding/metadata";

export function generateMetadata() {
  return moduleMetadata("outreach");
}

export default async function OutreachLayout({ children }: { children: ReactNode }) {
  await requireModuleAccess("outreach");
  const mod = getModule("outreach")!;
  return (
    <>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </>
  );
}
