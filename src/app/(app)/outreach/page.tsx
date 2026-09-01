import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";

// Outreach declares additionalAccessPermissions (outreach.send,
// outreach.send_unrestricted, outreach.manage_scopes; see modules/registry.ts),
// so a manage_scopes-only admin reaches this page without holding either send
// permission. Blindly redirecting to /outreach/campaigns -- which
// requireAnyPermission gates on those two send permissions -- would dead-end
// that admin at /no-access, the exact trap outreach/layout.tsx already guards
// the nav against. Widen this gate the same way recruitment/page.tsx widens
// its own for the personas its additionalAccessPermissions admit.
export default async function OutreachIndexPage() {
  const { personId } = await requirePersonSession();
  const [canSend, canSendUnrestricted, canManageScopes] = await Promise.all([
    can(personId, "outreach.send"),
    can(personId, "outreach.send_unrestricted"),
    can(personId, "outreach.manage_scopes"),
  ]);
  if (!canSend && !canSendUnrestricted && canManageScopes) {
    redirect("/outreach/scopes");
  }
  redirect("/outreach/campaigns");
}
