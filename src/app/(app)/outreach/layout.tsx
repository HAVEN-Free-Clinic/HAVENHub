import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { getModule } from "@/platform/modules/registry";
import { filterNavItems } from "@/platform/modules/access";
import { ModuleNav } from "@/platform/ui/module-nav";
import { moduleMetadata } from "@/platform/branding/metadata";

export function generateMetadata() {
  return moduleMetadata("outreach");
}

// Outreach declares additionalAccessPermissions (outreach.send,
// outreach.send_unrestricted, outreach.manage_scopes), so a holder of any ONE
// of those reaches the module without outreach.access (e.g. a manage_scopes-
// only admin, or a scoped sender with no other admin rights). Each nav item
// still enforces its own finer permission, so filter the nav to what the
// viewer can actually open -- unfiltered, a manage_scopes-only holder would
// see the unconditional Campaigns tab and dead-end at /no-access.
export default async function OutreachLayout({ children }: { children: ReactNode }) {
  const { personId } = await requireModuleAccess("outreach");
  const mod = getModule("outreach")!;
  const perms = await getEffectivePermissions(personId);
  return (
    <>
      <ModuleNav items={filterNavItems(mod.nav, perms)} />
      <div className="mt-8">{children}</div>
    </>
  );
}
