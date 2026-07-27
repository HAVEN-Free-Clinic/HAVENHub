import { prisma } from "@/platform/db";
import { requirePersonSession } from "@/platform/auth/session";
import { getEffectivePermissions, hasPermission } from "@/platform/rbac/engine";
import { getSetting } from "@/platform/settings/service";
import { getActiveTerm } from "@/platform/terms/active-term";
import { PageHeader } from "@/platform/ui/page-header";
import { StatCard } from "@/platform/ui/stat-card";
import { emailHealthCounts } from "@/modules/admin/services/email";
import { getCronHealth } from "@/platform/cron-heartbeat";
import { Alert } from "@/platform/ui/alert";

// requirePermission already ran in the admin layout; this page is reachable by
// any admin.access holder. Each stat card below targets a page with its OWN
// sub-permission, so we filter them to what the viewer can actually open
// (mirroring the nav filtering in the layout) -- otherwise a scoped admin sees
// cards that dead-end at /no-access.

export default async function AdminOverviewPage() {
  const { personId } = await requirePersonSession();
  const [appName, perms] = await Promise.all([
    getSetting<string>("branding.appName"),
    getEffectivePermissions(personId),
  ]);

  // Find the active term first so we can scope membership counts.
  const activeTerm = await getActiveTerm();

  const now = new Date();
  now.setDate(now.getDate() - 7);
  const sevenDaysAgo = now;

  // Run all counts in parallel for performance.
  const [
    activePersonCount,
    activeDeptCount,
    activeMembershipCount,
    roleCount,
    recentAuditCount,
    emailCounts,
  ] = await Promise.all([
    prisma.person.count({ where: { status: "ACTIVE" } }),
    prisma.department.count({ where: { isActive: true } }),
    activeTerm
      ? prisma.termMembership.count({
          where: { termId: activeTerm.id, status: "ACTIVE" },
        })
      : Promise.resolve(0),
    prisma.role.count(),
    prisma.auditLog.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    emailHealthCounts(),
  ]);

  // Flag any externally-scheduled cron job whose last success is stale (schedule
  // dropped / secret rotated). Dead enqueue-only jobs otherwise leave no signal.
  const cronHealth = await getCronHealth();
  const staleCrons = cronHealth.filter((c) => c.stale);

  const statCards = [
    { label: "Active People", value: activePersonCount, href: "/admin/people", permission: "admin.manage_people" },
    { label: activeTerm ? `${activeTerm.name} Memberships` : "Memberships", value: activeMembershipCount, href: "/admin/terms", permission: "admin.manage_terms" },
    { label: "Active Departments", value: activeDeptCount, href: "/admin/departments", permission: "admin.manage_departments" },
    { label: "Roles", value: roleCount, href: "/admin/roles", permission: "admin.manage_roles" },
    { label: "Audit Events (7 days)", value: recentAuditCount, href: "/admin/audit", permission: "admin.view_audit" },
    { label: `Email (${emailCounts.queued} queued, ${emailCounts.failed} failed)`, value: emailCounts.failed, href: "/admin/email", permission: "admin.manage_sync" },
  ].filter((c) => hasPermission(perms, c.permission));

  return (
    <div>
      <PageHeader
        title="Admin"
        description={`${appName} operations: people, terms, roles, and audit.`}
      />

      {staleCrons.length > 0 && (
        <div className="mt-6">
          <Alert tone="error">
            Scheduled jobs may have stopped running: {staleCrons.map((c) => c.label).join(", ")}. These run
            on an external scheduler; confirm it is still calling the cron endpoints (see docs/DEPLOY.md).
          </Alert>
        </div>
      )}

      {statCards.length > 0 && (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {statCards.map((c) => (
            <StatCard key={c.href} label={c.label} value={c.value} href={c.href} />
          ))}
        </div>
      )}
    </div>
  );
}
