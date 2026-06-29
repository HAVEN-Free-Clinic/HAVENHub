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
import { Field, Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button, buttonClasses } from "@/platform/ui/button";
import { StatCard } from "@/platform/ui/stat-card";
import {
  masterCompliance,
  setCompletionDateAsManager,
  ComplianceForbiddenError,
  CertificateNotFoundError,
} from "@/modules/volunteers/services/compliance";
import { CompletionDateError } from "@/platform/compliance/completion-date";
import { revalidatePath } from "next/cache";
import { CertificateViewer } from "@/modules/my-info/components/certificate-viewer";
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
  PENDING_VERIFICATION: "Needs verification",
  UNKNOWN_DATE: "Date Unknown",
  NO_CERTIFICATE: "No Certificate",
};

type Tone = "default" | "success" | "warning" | "critical";

const STATUS_TONE: Record<ComplianceStatus, Tone> = {
  COMPLIANT: "success",
  EXPIRING_SOON: "warning",
  EXPIRED: "critical",
  PENDING_VERIFICATION: "warning",
  UNKNOWN_DATE: "default",
  NO_CERTIFICATE: "default",
};

const ALL_STATUSES: ComplianceStatus[] = [
  "COMPLIANT",
  "EXPIRING_SOON",
  "EXPIRED",
  "PENDING_VERIFICATION",
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

  async function setDateAction(certId: string, dateIso: string): Promise<{ error?: string }> {
    "use server";
    const actor = await requirePermission("volunteers.manage_compliance");
    try {
      await setCompletionDateAsManager(actor.personId, certId, dateIso);
    } catch (err) {
      if (err instanceof CompletionDateError) return { error: err.reason };
      if (err instanceof ComplianceForbiddenError) return { error: err.message };
      if (err instanceof CertificateNotFoundError) return { error: "Certificate not found." };
      throw err;
    }
    revalidatePath("/volunteers/master");
    return {};
  }

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
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Compliant"
          value={result.summary.COMPLIANT}
          tone="success"
        />
        <StatCard
          label="Expiring Soon"
          value={result.summary.EXPIRING_SOON}
          tone="warning"
        />
        <StatCard
          label="Expired"
          value={result.summary.EXPIRED}
          tone="critical"
        />
        <StatCard
          label="Date Unknown"
          value={result.summary.UNKNOWN_DATE}
          tone="default"
        />
        <StatCard
          label="Needs verification"
          value={result.summary.PENDING_VERIFICATION}
          tone="warning"
        />
        <StatCard
          label="No Certificate"
          value={result.summary.NO_CERTIFICATE}
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
          <Field label="Search">
            <Input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder="Name or NetID..."
            />
          </Field>
        </div>

        <div className="w-52">
          <Field label="Department">
            <Select name="departmentId" defaultValue={departmentId ?? ""}>
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} - {d.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="w-44">
          <Field label="Status">
            <Select name="status" defaultValue={statusFilter ?? ""}>
              <option value="">All statuses</option>
              {ALL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Button type="submit" variant="primary" size="sm">
          Filter
        </Button>

        {(q || departmentId || statusFilter) && (
          <Link
            href="/volunteers/master"
            className={buttonClasses("outline", "sm")}
          >
            Clear
          </Link>
        )}
      </form>

      {/* Results */}
      <div className="mt-4">
        <p className="mb-3 text-sm text-muted-foreground">
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
                  <TH><span className="sr-only">Actions</span></TH>
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
                            className="text-brand-fg underline underline-offset-2 hover:opacity-75"
                          >
                            {row.person.name}
                          </Link>
                        ) : (
                          row.person.name
                        )}
                      </TD>
                      <TD className="text-foreground-soft text-sm">
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
                      <TD className="text-foreground-soft tabular-nums">
                        {fmtDate(row.cert?.completionDate)}
                      </TD>
                      <TD className="text-foreground-soft tabular-nums">
                        {fmtDate(expiresAt)}
                      </TD>
                      <TD className="text-foreground-soft text-xs">
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
                          <CertificateViewer
                            certId={row.cert.id}
                            fileName={row.cert.fileName}
                            ownerName={row.person.name}
                            completionDate={row.cert.completionDate}
                            canEditDate
                            canEditExistingDate={isAdmin}
                            onSetDate={setDateAction.bind(null, row.cert.id)}
                          />
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
