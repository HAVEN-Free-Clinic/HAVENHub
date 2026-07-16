import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { getModule } from "@/platform/modules/registry";
import { filterNavItems } from "@/platform/modules/access";
import { ModuleNav } from "@/platform/ui/module-nav";
import { moduleMetadata } from "@/platform/branding/metadata";

export function generateMetadata() {
  return moduleMetadata("incidents");
}

export default async function IncidentsLayout({ children }: { children: ReactNode }) {
  const { personId } = await requireModuleAccess("incidents");
  const mod = getModule("incidents")!;
  const perms = await getEffectivePermissions(personId);
  return (
    <>
      <ModuleNav items={filterNavItems(mod.nav, perms)} />
      <div className="mt-8">{children}</div>
    </>
  );
}
