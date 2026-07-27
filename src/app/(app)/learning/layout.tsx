import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { getModule } from "@/platform/modules/registry";
import { filterNavItems, canAccessModule } from "@/platform/modules/access";
import { ModuleNav } from "@/platform/ui/module-nav";
import { moduleMetadata } from "@/platform/branding/metadata";

export function generateMetadata() {
  return moduleMetadata("learning");
}

export default async function LearningLayout({ children }: { children: ReactNode }) {
  // Gate via canAccessModule so the module's additionalAccessPermissions
  // (learning.manage_courses / learning.view_progress) count as access, not only
  // learning.access. requireModuleAccess consults ONLY accessPermission, so a
  // manager who holds a management grant but no assigned courses (hence no
  // learning.access, which is only handed out by the kind-scoped Director/Volunteer
  // baselines) was redirected to /no-access before reaching /learning/manage -- even
  // though the dashboard tile and top nav advertise the module to them (#20). The
  // "My courses" landing page and each course page keep requiring learning.access
  // via requireModuleAccess (a manager has no assigned courses); the nav below is
  // filtered to what the viewer can actually open.
  const { personId } = await requirePersonSession();
  const mod = getModule("learning")!;
  const perms = await getEffectivePermissions(personId);
  if (!canAccessModule(mod, perms)) redirect("/no-access");
  return (
    <>
      <ModuleNav items={filterNavItems(mod.nav, perms)} />
      <div className="mt-8">{children}</div>
    </>
  );
}
