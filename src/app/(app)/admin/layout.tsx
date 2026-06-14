import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { ModuleNav } from "@/platform/ui/module-nav";

// Admin declares accessPermission: "admin.access", so requireModuleAccess
// resolves to requirePermission("admin.access").
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireModuleAccess("admin");
  const mod = getModule("admin")!;
  return (
    <>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </>
  );
}
