import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { getModule } from "@/platform/modules/registry";
import { filterNavItems, canAccessModule } from "@/platform/modules/access";
import { ModuleNav } from "@/platform/ui/module-nav";
import { DUAL_ROLE_QUEUE_PATH, directsADualRoleDepartment } from "@/platform/dual-roles";
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
  const [perms, hasDualRoleQueue] = await Promise.all([
    getEffectivePermissions(personId),
    directsADualRoleDepartment(personId),
  ]);
  if (!canAccessModule(mod, perms)) redirect("/no-access");
  // Permission gate first, then the data-driven one. Dual roles is marked
  // dynamicGate in the registry precisely because every director holds the
  // permission while only the departments that ask the question have a queue,
  // so the global nav omits it and this is the one place that can decide.
  const items = filterNavItems(mod.nav, perms).filter(
    (item) => item.href !== DUAL_ROLE_QUEUE_PATH || hasDualRoleQueue,
  );
  return (
    <>
      <ModuleNav items={items} />
      <div className="mt-8">{children}</div>
    </>
  );
}
