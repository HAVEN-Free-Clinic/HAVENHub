import Link from "next/link";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";

// ---------------------------------------------------------------------------
// Business days helper
// ---------------------------------------------------------------------------

/**
 * Counts business days (Mon–Fri) between a past date and now. Used to
 * flag tickets that have been open too long without a response from YNHH.
 */
function businessDaysSince(date: Date): number {
  const cur = new Date(date);
  const end = new Date();
  let count = 0;
  cur.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  while (cur < end) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

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

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-10 pt-10 pb-8 border-b border-slate-200">
          <div className="flex items-start gap-6">
            <div className="w-16 h-16 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'color-mix(in srgb, var(--brand) 10%, white)' }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-brand">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap mb-2">
                <h2 className="text-xl font-semibold text-slate-800">YNHH Epic requests</h2>
                {pendingCount > 0 && (
                  <span className="text-xs font-medium px-3 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                    {pendingCount} pending
                  </span>
                )}
              </div>
              <p className="text-base text-slate-500 leading-relaxed max-w-xl">
                Generate service request PDFs, Excel spreadsheets, and email drafts for new, modify, and renew Epic access requests. Track open tickets and time since submission.
              </p>
            </div>
          </div>

          {overdueCount > 0 && (
            <div className="mt-6 flex items-center gap-3 rounded-lg bg-red-50 border border-red-200 px-5 py-4">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-red-600 shrink-0">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <p className="text-sm font-medium text-red-700">
                {overdueCount} {overdueCount === 1 ? "request has" : "requests have"} been open for more than 7 business days — follow up with the YNHH helpdesk.
              </p>
            </div>
          )}
        </div>

        <div className="px-10 py-8 flex gap-3 flex-wrap">
          <Link
            href="/admin/itcm/epic-requests?tab=generate"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-brand text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="12" y1="18" x2="12" y2="12"/>
              <line x1="9" y1="15" x2="15" y2="15"/>
            </svg>
            Generate request PDF
          </Link>
          <Link
            href="/admin/itcm/epic-requests?tab=tracker"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6"/>
              <line x1="8" y1="12" x2="21" y2="12"/>
              <line x1="8" y1="18" x2="21" y2="18"/>
              <line x1="3" y1="6" x2="3.01" y2="6"/>
              <line x1="3" y1="12" x2="3.01" y2="12"/>
              <line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
            View tracker
          </Link>
        </div>
      </div>
    </div>
  );
}