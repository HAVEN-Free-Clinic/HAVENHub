import Link from "next/link";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { StatCard } from "@/platform/ui/stat-card";

export default async function ItcmPage() {
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });

  const [pendingEpicCount, completedEpicCount] = await Promise.all([
    prisma.epicRequest.count({
      where: { status: { in: ["PENDING", "SUBMITTED"] } },
    }),
    prisma.epicRequest.count({
      where: { status: "COMPLETED" },
    }),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="ITCM"
        description={`IT & Communications tools for ${activeTerm?.name ?? "the active term"}: Epic access requests and compliance infrastructure.`}
      />

      {/* Epic Requests feature card */}
      <Link
        href="/admin/itcm/epic-requests"
        className="block rounded-xl border border-slate-200 bg-white p-6 hover:border-brand hover:shadow-md transition-all group"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-base font-semibold text-slate-800 group-hover:text-brand transition-colors">
              YNHH Epic Requests
            </p>
            <p className="text-sm text-slate-500">
              Generate service request PDFs, Excel spreadsheets, and email drafts. Track submission status and business days open.
            </p>
          </div>
          <span className="text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-medium shrink-0">
            {pendingEpicCount} pending
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <StatCard
            label="Pending Epic Requests"
            value={pendingEpicCount}
          />
          <StatCard
            label="Completed Epic Requests"
            value={completedEpicCount}
          />
        </div>
      </Link>
    </div>
  );
}