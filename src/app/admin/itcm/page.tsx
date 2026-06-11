import Link from "next/link";
import { FileText, AlertTriangle, FilePlus, ListChecks } from "lucide-react";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";
import { Badge } from "@/platform/ui/badge";
import { businessDaysSince } from "@/platform/dates";

export default async function ItcmPage() {
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });

  // Load open tickets to compute pending count and overdue count.
  const openTickets = await prisma.ynhhTicket.findMany({
    where: { status: "OPEN" },
    select: { submittedAt: true },
  });

  const pendingCount = openTickets.length;
  const overdueCount = openTickets.filter(
    (t) => businessDaysSince(t.submittedAt) > 7
  ).length;

  return (
    <div className="space-y-8">
      <PageHeader
        title="ITCM"
        description={`IT & Communications tools for ${activeTerm?.name ?? "the active term"}.`}
      />

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="px-10 pt-10 pb-8 border-b border-slate-200">
          <div className="flex items-start gap-6">
            <div className="w-16 h-16 rounded-xl flex items-center justify-center shrink-0 bg-brand-faint">
              <FileText className="h-8 w-8 text-brand" aria-hidden />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap mb-2">
                <h2 className="text-xl font-semibold text-slate-800">YNHH Epic requests</h2>
                {pendingCount > 0 && (
                  <Badge tone="warning">{pendingCount} pending</Badge>
                )}
              </div>
              <p className="text-base text-slate-500 leading-relaxed max-w-xl">
                Generate service request PDFs, Excel spreadsheets, and email drafts for new, modify, and renew Epic access requests. Track open tickets and time since submission.
              </p>
            </div>
          </div>

          {overdueCount > 0 && (
            <div className="mt-6 flex items-center gap-3 rounded-xl border border-critical/20 bg-red-50 px-5 py-4">
              <AlertTriangle className="h-5 w-5 text-critical shrink-0" aria-hidden />
              <p className="text-sm font-medium text-critical">
                {overdueCount} {overdueCount === 1 ? "request has" : "requests have"} been open for more than 7 business days — follow up with the YNHH helpdesk.
              </p>
            </div>
          )}
        </div>

        <div className="px-10 py-8 flex gap-3 flex-wrap">
          <Link
            href="/admin/itcm/epic-requests?tab=generate"
            className={buttonClasses("primary", "md", "gap-2")}
          >
            <FilePlus className="h-4 w-4" aria-hidden />
            Generate request PDF
          </Link>
          <Link
            href="/admin/itcm/epic-requests?tab=tracker"
            className={buttonClasses("outline", "md", "gap-2")}
          >
            <ListChecks className="h-4 w-4" aria-hidden />
            View tracker
          </Link>
        </div>
      </div>
    </div>
  );
}
