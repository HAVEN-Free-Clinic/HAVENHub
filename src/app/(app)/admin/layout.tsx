import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { getModule } from "@/platform/modules/registry";
import { filterNavItems } from "@/platform/modules/access";
import { ModuleNav } from "@/platform/ui/module-nav";

// Admin declares accessPermission: "admin.access", so requireModuleAccess
// resolves to requirePermission("admin.access"). Sub-tabs each enforce a
// finer permission, so the nav is filtered to what the viewer can actually open.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { personId } = await requireModuleAccess("admin");
  const mod = getModule("admin")!;
  const perms = await getEffectivePermissions(personId);
  return (
    <>
      <ModuleNav items={filterNavItems(mod.nav, perms)} />
      <div className="mt-8">{children}</div>
    </>
  );
}
