import Link from "next/link";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";
import { StatCard } from "@/platform/ui/stat-card";

// requirePermission already ran in the admin layout; this page is reachable
// only by users with admin.access. No second permission check needed here.

export default async function ItcmPage() {
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });

  // Count pending and completed Epic requests in the active term for the
  // overview stats. Completed = status COMPLETED; pending = PENDING or SUBMITTED.
  const [pendingEpicCount, completedEpicCount] = await Promise.all([
    prisma.epicRequest.count({
      where: { status: { in: ["PENDING", "SUBMITTED"] } },
    }),
    prisma.epicRequest.count({
      where: { status: "COMPLETED" },
    }),
  ]);

  const quickLinks = [
    { label: "Epic Requests", href: "/admin/itcm/epic-requests" },
  ];

  return (
    <div>
      <PageHeader
        title="ITCM"
        description={`IT & Communications tools for ${activeTerm?.name ?? "the active term"}: Epic access requests and compliance infrastructure.`}
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
          label="Pending Epic Requests"
          value={pendingEpicCount}
          href="/admin/itcm/epic-requests"
        />
        <StatCard
          label="Completed Epic Requests"
          value={completedEpicCount}
          href="/admin/itcm/epic-requests"
        />
      </div>
    </div>
  );
}