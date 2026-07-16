import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { getModule } from "@/platform/modules/registry";
import { filterNavItems, canAccessModule } from "@/platform/modules/access";
import { ModuleNav } from "@/platform/ui/module-nav";
import { moduleMetadata } from "@/platform/branding/metadata";

export function generateMetadata() {
  return moduleMetadata("volunteers");
}

export default async function VolunteersLayout({ children }: { children: ReactNode }) {
  // Gate via canAccessModule so the module's additionalAccessPermissions
  // (volunteers.verify_spanish) count as access, not only volunteers.view.
  // Otherwise a Spanish-review-only reviewer 403s at the layout before reaching
  // their page. Each page still enforces its own permission.
  const { personId } = await requirePersonSession();
  const mod = getModule("volunteers")!;
  const perms = await getEffectivePermissions(personId);
  if (!canAccessModule(mod, perms)) redirect("/no-access");
  return (
    <>
      <ModuleNav items={filterNavItems(mod.nav, perms)} />
      <div className="mt-8">{children}</div>
    </>
  );
}
