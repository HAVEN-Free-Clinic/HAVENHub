import Link from "next/link";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { getActiveTerm } from "@/platform/terms/active-term";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";
import { StatCard } from "@/platform/ui/stat-card";
import { emailHealthCounts } from "@/modules/admin/services/email";

// requirePermission already ran in the admin layout; this page is reachable only
// by users with admin.access. No second permission check needed here.

export default async function AdminOverviewPage() {
  const appName = await getSetting<string>("branding.appName");

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

  const quickLinks = [
    { label: "People", href: "/admin/people" },
    { label: "Terms", href: "/admin/terms" },
    { label: "Roles", href: "/admin/roles" },
    { label: "Subcommittees", href: "/admin/subcommittees" },
    { label: "Audit", href: "/admin/audit" },
  ];

  return (
    <div>
      <PageHeader
        title="Admin"
        description={`${appName} operations: people, terms, roles, and audit.`}
        action={
          <div className="flex flex-wrap gap-2">
            {quickLinks.map((ql) => (
              <Link
                key={ql.href}
                href={ql.href}
                className={buttonClasses("outline", "sm")}
              >
                {ql.label}
              </Link>
            ))}
          </div>
        }
      />

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Active People"
          value={activePersonCount}
          href="/admin/people"
        />
        <StatCard
          label={activeTerm ? `${activeTerm.name} Memberships` : "Memberships"}
          value={activeMembershipCount}
          href="/admin/terms"
        />
        <StatCard
          label="Active Departments"
          value={activeDeptCount}
          href="/admin/people"
        />
        <StatCard
          label="Roles"
          value={roleCount}
          href="/admin/roles"
        />
        <StatCard
          label="Audit Events (7 days)"
          value={recentAuditCount}
          href="/admin/audit"
        />
        <StatCard
          label={`Email (${emailCounts.queued} queued, ${emailCounts.failed} failed)`}
          value={emailCounts.failed}
          href="/admin/email"
        />
      </div>
    </div>
  );
}
