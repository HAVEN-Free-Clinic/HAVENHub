import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { getModule } from "@/platform/modules/registry";
import { filterNavItems } from "@/platform/modules/access";
import { PageHeader } from "@/platform/ui/page-header";

/**
 * /admin has no page of its own any more: it opens the first Admin tab the
 * viewer can use.
 *
 * It was an "Overview" of six stat cards, each a link to a tab already in the
 * row directly above it, plus the stale-cron alert, which now sits on
 * /admin/email beside the delivery logs those jobs feed. The module root is
 * still where the tile, the toolbar chip and the "Admin" crumb point, so it has
 * to resolve somewhere real.
 *
 * "First tab" means the first item the tab row would draw for this viewer: a
 * folded page (underTab) counts only when its parent is hidden from them. That
 * is how a role granted only admin.manage_email_templates still lands on the
 * templates it exists to grant, rather than on a tab it cannot open.
 */
export default async function AdminRoot() {
  const { personId } = await requirePersonSession();
  const perms = await getEffectivePermissions(personId);
  const items = filterNavItems(getModule("admin")!.nav, perms);
  const visible = new Set(items.map((item) => item.href));
  const first = items.find((item) => !item.underTab || !visible.has(item.underTab));
  if (first) redirect(first.href);

  // admin.access with no sub-permission opens the module but none of its tools.
  return (
    <div>
      <PageHeader title="Admin" description="Your role opens the Admin module, but none of its tools yet." />
      <p className="mt-6 text-sm text-muted-foreground">Ask the IT team for the access you need.</p>
    </div>
  );
}
