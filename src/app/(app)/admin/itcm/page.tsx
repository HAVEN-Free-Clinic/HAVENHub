import Link from "next/link";
import { FileText, AlertTriangle, FilePlus, ListChecks } from "lucide-react";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";
import { Badge } from "@/platform/ui/badge";
import { businessDaysSince } from "@/platform/dates";
import { Card } from "@/platform/ui/card";

export default async function ItcmPage() {
  const activeTerm = await getActiveTerm();

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

      <Card pad={false} className="overflow-hidden">
        <div className="px-10 pt-10 pb-8 border-b border-border">
          <div className="flex items-start gap-6">
            <div className="w-16 h-16 rounded-xl flex items-center justify-center shrink-0 bg-brand-faint">
              <FileText className="h-8 w-8 text-brand-fg" aria-hidden />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap mb-2">
                <h2 className="text-xl font-semibold text-foreground">YNHH Epic requests</h2>
                {pendingCount > 0 && (
                  <Badge tone="warning">{pendingCount} pending</Badge>
                )}
              </div>
              <p className="text-base text-muted-foreground leading-relaxed max-w-xl">
                Generate service request PDFs, Excel spreadsheets, and email drafts for new, modify, and renew Epic access requests. Track open tickets and time since submission.
              </p>
            </div>
          </div>

          {overdueCount > 0 && (
            <Card size="compact" pad={false} className="mt-6 flex items-center gap-3 px-5 py-4">
              <AlertTriangle className="h-5 w-5 text-critical shrink-0" aria-hidden />
              <p className="text-sm font-medium text-foreground">
                {overdueCount} {overdueCount === 1 ? "request has" : "requests have"} been open for more than 7 business days. Follow up with the YNHH helpdesk.
              </p>
            </Card>
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
      </Card>
    </div>
  );
}
