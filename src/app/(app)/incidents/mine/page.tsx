/**
 * "My reports" page for Incident Reports.
 *
 * Access: requirePersonSession() only -- any signed-in matched person may
 * view the reports they have filed (this module declares no accessPermission,
 * matching the "Report a concern" and "My reports" nav items).
 *
 * Lists the actor's own reports via listMyReports, newest first (the
 * service's order). Each row links to /incidents/[id] for the read-only
 * detail view. A ?submitted=<number> query param (set by submitReportAction's
 * post-submit redirect) shows a one-time success banner.
 */

import Link from "next/link";
import { requirePersonSession } from "@/platform/auth/session";
import { listMyReports, CONCERN_TYPES } from "@/modules/incidents/services/report";
import type { IncidentReportStatus } from "@prisma/client";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Alert } from "@/platform/ui/alert";
import { DateOnly } from "@/platform/dates/display";
import { formatSubjectNames, aggregateStrikeLabel } from "@/app/(app)/incidents/subject-display";

// ---------------------------------------------------------------------------
// Status + strike labels
// ---------------------------------------------------------------------------

type BadgeTone = "default" | "success" | "warning" | "critical";

const STATUS_LABELS: Record<IncidentReportStatus, string> = {
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  RESOLVED: "Resolved",
  DISMISSED: "Dismissed",
};

const STATUS_TONES: Record<IncidentReportStatus, BadgeTone> = {
  SUBMITTED: "default",
  UNDER_REVIEW: "warning",
  RESOLVED: "success",
  DISMISSED: "default",
};

const CONCERN_LABELS: Record<string, string> = Object.fromEntries(
  CONCERN_TYPES.map((t) => [t.value, t.label])
);

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

type PageProps = {
  searchParams: Promise<{ submitted?: string }>;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function MyReportsPage({ searchParams }: PageProps) {
  const actor = await requirePersonSession();
  const sp = await searchParams;

  const rows = await listMyReports(actor.personId);

  return (
    <div>
      <PageHeader title="My reports" description="Incident reports you have filed." />

      {sp.submitted && (
        <Alert tone="success" className="mt-4">
          Report #{sp.submitted} submitted.
        </Alert>
      )}

      {rows.length === 0 ? (
        <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
          <p>You have not filed any incident reports.</p>
          <Link href="/incidents" className={buttonClasses("primary", "sm")}>
            Report a concern
          </Link>
        </div>
      ) : (
        <div className="mt-8">
          <Table>
            <THead>
              <TR>
                <TH>Number</TH>
                <TH>Concern types</TH>
                <TH>Subject</TH>
                <TH>Status</TH>
                <TH>Strike</TH>
                <TH>Submitted</TH>
              </TR>
            </THead>
            <tbody>
              {rows.map(({ report, subjectNames, strikePendingCount, strikeIssuedCount }) => (
                <TR key={report.id}>
                  <TD>
                    <Link href={`/incidents/${report.id}`} className="font-medium text-brand-fg hover:underline">
                      #{report.number}
                    </Link>
                  </TD>
                  <TD className="max-w-xs text-sm text-foreground-soft">
                    {report.concernTypes.map((c) => CONCERN_LABELS[c] ?? c).join(", ")}
                  </TD>
                  <TD className="text-sm text-foreground-soft">{formatSubjectNames(subjectNames)}</TD>
                  <TD>
                    <Badge tone={STATUS_TONES[report.status]}>{STATUS_LABELS[report.status]}</Badge>
                  </TD>
                  <TD className="text-sm text-foreground-soft">
                    {aggregateStrikeLabel(strikePendingCount, strikeIssuedCount)}
                  </TD>
                  <TD className="whitespace-nowrap text-sm text-foreground-soft">
                    <DateOnly value={report.createdAt} />
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}
