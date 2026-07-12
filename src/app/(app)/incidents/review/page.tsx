/**
 * Reviewer queue for Incident Reports.
 *
 * Access: requirePermission("incidents.manage"). Lists every incident report
 * (not just the viewer's own), filtered and paginated by listReviewQueue,
 * which orders immediate-risk reports first, then newest first.
 *
 * Filters (all optional, combined with AND): status, concernType,
 * immediateRisk (checked = risk-flagged only), strikePending (checked =
 * strikeDecision PENDING only), q (matches subject name, reporter name, or
 * report number). Page size is fixed by the service at 25.
 *
 * Each row links to /incidents/[id], where a reviewer sets status/notes and
 * decides any pending strike request (Task 15's other half).
 */

import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listReviewQueue, CONCERN_TYPES } from "@/modules/incidents/services/report";
import type { IncidentReportStatus } from "@prisma/client";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Field, Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Pagination } from "@/platform/ui/pagination";
import { DateOnly } from "@/platform/dates/display";
import { formatSubjectNames } from "@/app/(app)/incidents/subject-display";

// ---------------------------------------------------------------------------
// Status + concern labels
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

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

type PageProps = {
  searchParams: Promise<{
    status?: string;
    concernType?: string;
    immediateRisk?: string;
    strikePending?: string;
    q?: string;
    page?: string;
  }>;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function IncidentReviewPage({ searchParams }: PageProps) {
  const viewer = await requirePermission("incidents.manage");
  const sp = await searchParams;

  const status = sp.status || undefined;
  const concernType = sp.concernType || undefined;
  const immediateRisk = sp.immediateRisk === "on";
  const strikePending = sp.strikePending === "on";
  const q = sp.q?.trim() || undefined;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const { rows, total } = await listReviewQueue(viewer.personId, {
    status,
    concernType,
    immediateRisk,
    strikePending,
    q,
    page,
  });

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function buildHref(targetPage: number): string {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (concernType) params.set("concernType", concernType);
    if (immediateRisk) params.set("immediateRisk", "on");
    if (strikePending) params.set("strikePending", "on");
    if (q) params.set("q", q);
    params.set("page", String(targetPage));
    return `/incidents/review?${params.toString()}`;
  }

  const hasFilters = Boolean(status || concernType || immediateRisk || strikePending || q);

  return (
    <div>
      <PageHeader
        title="Review queue"
        description="All incident reports. Immediate-risk reports sort first."
      />

      {/* Filter bar */}
      <form
        method="GET"
        action="/incidents/review"
        className="mt-8 flex flex-wrap items-end gap-3"
      >
        <div className="flex-1 min-w-44">
          <Field label="Search">
            <Input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder="Subject, reporter, or report #..."
            />
          </Field>
        </div>

        <div className="w-48">
          <Field label="Status">
            <Select name="status" defaultValue={status ?? ""}>
              <option value="">All statuses</option>
              {(Object.keys(STATUS_LABELS) as IncidentReportStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="w-56">
          <Field label="Concern type">
            <Select name="concernType" defaultValue={concernType ?? ""}>
              <option value="">All concern types</option>
              {CONCERN_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex items-center gap-4 pb-2">
          <label className="flex items-center gap-2 text-sm text-foreground-soft cursor-pointer">
            <Checkbox name="immediateRisk" defaultChecked={immediateRisk} />
            Immediate risk only
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground-soft cursor-pointer">
            <Checkbox name="strikePending" defaultChecked={strikePending} />
            Pending strike only
          </label>
        </div>

        <Button type="submit" variant="primary" size="sm">
          Filter
        </Button>

        {hasFilters && (
          <Link href="/incidents/review" className={buttonClasses("outline", "sm")}>
            Clear
          </Link>
        )}
      </form>

      {/* Queue table */}
      <section className="mt-6">
        {rows.length === 0 ? (
          <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
            <p>No incident reports match these filters.</p>
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              {total} report{total === 1 ? "" : "s"}
            </p>

            <Table>
              <THead>
                <TR>
                  <TH>Number</TH>
                  <TH>Reporter</TH>
                  <TH>Subject</TH>
                  <TH>Concern types</TH>
                  <TH>Immediate risk</TH>
                  <TH>Strike</TH>
                  <TH>Status</TH>
                  <TH>Submitted</TH>
                </TR>
              </THead>
              <tbody>
                {rows.map(({ report, reporterName, subjectNames, strikePendingCount }) => (
                  <TR key={report.id}>
                    <TD>
                      <Link
                        href={`/incidents/${report.id}`}
                        className="font-medium text-brand-fg hover:underline"
                      >
                        #{report.number}
                      </Link>
                    </TD>
                    <TD className="text-sm text-foreground-soft">{reporterName}</TD>
                    <TD className="text-sm text-foreground-soft">
                      {formatSubjectNames(subjectNames)}
                    </TD>
                    <TD className="max-w-xs text-sm text-foreground-soft">
                      {report.concernTypes.map((c) => CONCERN_LABELS[c] ?? c).join(", ")}
                    </TD>
                    <TD>
                      {report.immediateRisk && <Badge tone="critical">Immediate risk</Badge>}
                    </TD>
                    <TD>
                      {strikePendingCount > 0 && <Badge tone="warning">Strike pending</Badge>}
                    </TD>
                    <TD>
                      <Badge tone={STATUS_TONES[report.status]}>{STATUS_LABELS[report.status]}</Badge>
                    </TD>
                    <TD className="whitespace-nowrap text-sm text-foreground-soft">
                      <DateOnly value={report.createdAt} />
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>

            <div className="mt-4">
              <Pagination page={page} pageCount={pageCount} hrefFor={buildHref} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
