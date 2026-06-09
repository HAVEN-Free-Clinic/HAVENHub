/**
 * Master compliance view: all active members across the clinic in the active term.
 *
 * Access: requirePermission("volunteers.manage_compliance").
 *
 * NOTE on layout/permission layering:
 *   The volunteers layout uses requireModuleAccess("volunteers") which gates on
 *   volunteers.view. The Compliance Manager role grants BOTH volunteers.view AND
 *   volunteers.manage_compliance, so holders pass both checks. This page adds a
 *   second requirePermission("volunteers.manage_compliance") call for defense in
 *   depth - someone who has volunteers.view but NOT manage_compliance would be
 *   bounced here even though the layout admitted them.
 */

import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Pagination } from "@/platform/ui/pagination";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { masterCompliance } from "@/modules/volunteers/services/compliance";
import type { ComplianceStatus } from "@/platform/compliance/rules";
import { certExpiresAt } from "@/platform/compliance/rules";
import Link from "next/link";

type PageProps = {
  searchParams: Promise<{
    q?: string;
    departmentId?: string;
    status?: string;
    page?: string;
  }>;
};

// ---------------------------------------------------------------------------
// Status display helpers (shared with /volunteers)
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<ComplianceStatus, string> = {
  COMPLIANT: "Compliant",
  EXPIRING_SOON: "Expiring Soon",
  EXPIRED: "Expired",
  UNKNOWN_DATE: "Date Unknown",
  NO_CERTIFICATE: "No Certificate",
};

type Tone = "default" | "success" | "warning" | "critical";

const STATUS_TONE: Record<ComplianceStatus, Tone> = {
  COMPLIANT: "success",
  EXPIRING_SOON: "warning",
  EXPIRED: "critical",
  UNKNOWN_DATE: "default",
  NO_CERTIFICATE: "default",
};

const ALL_STATUSES: ComplianceStatus[] = [
  "COMPLIANT",
  "EXPIRING_SOON",
  "EXPIRED",
  "UNKNOWN_DATE",
  "NO_CERTIFICATE",
];

// ---------------------------------------------------------------------------
// Date formatting (UTC)
// ---------------------------------------------------------------------------

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "-";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// Summary stat card
// ---------------------------------------------------------------------------

function SummaryCard({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: Tone;
}) {
  const colorClasses: Record<Tone, string> = {
    success: "border-green-200 bg-green-50",
    warning: "border-amber-200 bg-amber-50",
    critical: "border-red-200 bg-red-50",
    default: "border-slate-200 bg-slate-50",
  };
  const countClasses: Record<Tone, string> = {
    success: "text-success",
    warning: "text-warning",
    critical: "text-critical",
    default: "text-slate-600",
  };

  return (
    <div
      className={`rounded-lg border px-4 py-3 ${colorClasses[tone]}`}
      aria-label={`${label}: ${count}`}
    >
      <p className={`text-2xl font-semibold tabular-nums ${countClasses[tone]}`}>{count}</p>
      <p className="mt-0.5 text-xs text-slate-500">{label}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function MasterCompliancePage({ searchParams }: PageProps) {
  // Page-level permission gate. The layout already requires volunteers.view;
  // this adds manage_compliance on top of that.
  const viewer = await requirePermission("volunteers.manage_compliance");
  const sp = await searchParams;

  const q = sp.q?.trim() || undefined;
  const departmentId = sp.departmentId || undefined;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const rawStatus = sp.status;
  const statusFilter: ComplianceStatus | undefined =
    rawStatus && (ALL_STATUSES as string[]).includes(rawStatus)
      ? (rawStatus as ComplianceStatus)
      : undefined;

  // Fetch master compliance data
  const result = await masterCompliance({
    q,
    departmentId,
    status: statusFilter,
    page,
    pageSize: 25,
  });

  // Fetch active departments for the filter select
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });

  const departments =
    activeTerm
      ? await prisma.department.findMany({
          where: {
            memberships: {
              some: { termId: activeTerm.id, status: "ACTIVE" },
            },
          },
          orderBy: { code: "asc" },
        })
      : [];

  // Check if viewer has admin access to link person names to admin pages
  const isAdmin = await can(viewer.personId, "admin.access");

  // Build filter-preserving hrefs for pagination
  function buildHref(targetPage: number): string {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (departmentId) params.set("departmentId", departmentId);
    if (statusFilter) params.set("status", statusFilter);
    params.set("page", String(targetPage));
    return `/volunteers/master?${params.toString()}`;
  }

  return (
    <div>
      <PageHeader
        title="Master Compliance View"
        description="HIPAA compliance status across all active clinic members"
      />

      {/* Summary stat cards */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <SummaryCard
          label="Compliant"
          count={result.summary.COMPLIANT}
          tone="success"
        />
        <SummaryCard
          label="Expiring Soon"
          count={result.summary.EXPIRING_SOON}
          tone="warning"
        />
        <SummaryCard
          label="Expired"
          count={result.summary.EXPIRED}
          tone="critical"
        />
        <SummaryCard
          label="Date Unknown"
          count={result.summary.UNKNOWN_DATE}
          tone="default"
        />
        <SummaryCard
          label="No Certificate"
          count={result.summary.NO_CERTIFICATE}
          tone="default"
        />
      </div>

      {/* Filter bar - GET form so filters are in the URL */}
      <form
        method="GET"
        action="/volunteers/master"
        className="mt-6 flex flex-wrap items-end gap-3"
      >
        <div className="flex-1 min-w-48">
          <label className="block text-xs font-medium text-slate-500 mb-1">
            Search
          </label>
          <Input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Name or NetID..."
          />
        </div>

        <div className="w-52">
          <label className="block text-xs font-medium text-slate-500 mb-1">
            Department
          </label>
          <Select name="departmentId" defaultValue={departmentId ?? ""}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} - {d.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="w-44">
          <label className="block text-xs font-medium text-slate-500 mb-1">
            Status
          </label>
          <Select name="status" defaultValue={statusFilter ?? ""}>
            <option value="">All statuses</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>

        <button
          type="submit"
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
        >
          Filter
        </button>

        {(q || departmentId || statusFilter) && (
          <Link
            href="/volunteers/master"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
          >
            Clear
          </Link>
        )}
      </form>

      {/* Results */}
      <div className="mt-4">
        <p className="mb-3 text-sm text-slate-500">
          {result.total === 0
            ? "No members found."
            : `${result.total} member${result.total === 1 ? "" : "s"}`}
        </p>

        {result.rows.length > 0 && (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Departments</TH>
                  <TH>Status</TH>
                  <TH>Training</TH>
                  <TH>Overall</TH>
                  <TH>Completed</TH>
                  <TH>Expires</TH>
                  <TH>Verified</TH>
                  <TH></TH>
                </TR>
              </THead>
              <tbody>
                {result.rows.map((row) => {
                  const expiresAt = row.cert?.completionDate
                    ? certExpiresAt(row.cert.completionDate)
                    : null;

                  return (
                    <TR key={row.person.id}>
                      <TD className="font-medium">
                        {isAdmin ? (
                          <Link
                            href={`/admin/people/${row.person.id}`}
                            className="text-brand underline underline-offset-2 hover:opacity-75"
                          >
                            {row.person.name}
                          </Link>
                        ) : (
                          row.person.name
                        )}
                      </TD>
                      <TD className="text-slate-600 text-sm">
                        {row.departments.join(", ")}
                      </TD>
                      <TD>
                        <Badge tone={STATUS_TONE[row.status]}>
                          {STATUS_LABEL[row.status]}
                        </Badge>
                      </TD>
                      <TD>
                        <Badge
                          tone={row.trainingState === "COMPLETE" ? "success" : "default"}
                        >
                          {row.trainingState === "COMPLETE" ? "Complete" : "Pending"}
                        </Badge>
                      </TD>
                      <TD>
                        <Badge
                          tone={
                            row.overallClearance === "CLEARED" ? "success" : "critical"
                          }
                        >
                          {row.overallClearance === "CLEARED" ? "Cleared" : "Not Cleared"}
                        </Badge>
                      </TD>
                      <TD className="text-slate-600 tabular-nums">
                        {fmtDate(row.cert?.completionDate)}
                      </TD>
                      <TD className="text-slate-600 tabular-nums">
                        {fmtDate(expiresAt)}
                      </TD>
                      <TD className="text-slate-600 text-xs">
                        {row.cert?.verifiedAt ? (
                          <span>
                            {row.verifiedByName} {fmtDate(row.cert.verifiedAt)}
                          </span>
                        ) : (
                          "-"
                        )}
                      </TD>
                      <TD>
                        {row.cert && (
                          <a
                            href={`/my-info/certificate/${row.cert.id}`}
                            className="text-xs text-brand underline underline-offset-2 hover:opacity-75"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Download
                          </a>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>

            <div className="mt-4">
              <Pagination
                page={result.page}
                pageCount={result.pageCount}
                hrefFor={buildHref}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
