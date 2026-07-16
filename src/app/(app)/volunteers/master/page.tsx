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
import { getActiveTerm } from "@/platform/terms/active-term";
import { can } from "@/platform/rbac/engine";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Pagination } from "@/platform/ui/pagination";
import { Field, Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button, buttonClasses } from "@/platform/ui/button";
import { StatCard } from "@/platform/ui/stat-card";
import { Alert } from "@/platform/ui/alert";
import { NavForm } from "@/platform/ui/nav-form";
import {
  masterCompliance,
  setCompletionDateAsManager,
  verifyCertificate,
  ComplianceForbiddenError,
  CertificateNotFoundError,
} from "@/modules/volunteers/services/compliance";
import { CompletionDateError } from "@/platform/compliance/completion-date";
import { revalidatePath } from "next/cache";
import { CertificateViewer } from "@/modules/my-info/components/certificate-viewer";
import type { ComplianceStatus } from "@/platform/compliance/rules";
import { certExpiresAt } from "@/platform/compliance/rules";
import { CalendarDate, DateOnly } from "@/platform/dates/display";
import Link from "next/link";
import type { OnboardingTaskKey, OnboardingTaskState } from "@/modules/onboarding/engine/status";

type PageProps = {
  searchParams: Promise<{
    q?: string;
    departmentId?: string;
    status?: string;
    page?: string;
    error?: string;
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

// Clearance task display (learning + EHS columns).
function taskState(
  clearance: { tasks: { key: OnboardingTaskKey; state: OnboardingTaskState }[] },
  key: OnboardingTaskKey
): OnboardingTaskState | null {
  return clearance.tasks.find((t) => t.key === key)?.state ?? null;
}

const TASK_STATE_LABEL: Record<OnboardingTaskState, string> = {
  COMPLETE: "Complete",
  IN_PROGRESS: "In progress",
  INCOMPLETE: "Incomplete",
  NOT_REQUIRED: "Not required",
};

const TASK_STATE_TONE: Record<OnboardingTaskState, Tone> = {
  COMPLETE: "success",
  IN_PROGRESS: "warning",
  INCOMPLETE: "critical",
  NOT_REQUIRED: "default",
};

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

  // searchParams arrive already URL-decoded in the App Router; do not decode again.
  const errorMessage = sp.error || null;

  // Fetch master compliance data
  const result = await masterCompliance({
    q,
    departmentId,
    status: statusFilter,
    page,
    pageSize: 25,
  });

  // Fetch active departments for the filter select
  const activeTerm = await getActiveTerm();

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

  // Server action: verify a certificate. certId is bound per-row. Gated to
  // volunteers.manage_compliance, the master-view persona. verifyCertificate
  // treats manage_compliance as a master key, so a ComplianceForbiddenError is
  // defensive; it is surfaced in the viewer modal like setDateAction's errors.
  async function verifyAction(certId: string): Promise<{ error?: string }> {
    "use server";
    const actor = await requirePermission("volunteers.manage_compliance");
    try {
      await verifyCertificate(actor.personId, certId);
    } catch (err) {
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
        title="Master compliance view"
        description="Full clearance status across all active clinic members: HIPAA, training, learning, and EHS."
      />

      {errorMessage && (
        <Alert tone="error" className="mt-4">
          {errorMessage}
        </Alert>
      )}

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

      {/* Clearance summary (full clearance, not just HIPAA) */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <StatCard label="Fully cleared" value={result.clearedCount} tone="success" />
        <StatCard label="Missing EHS" value={result.ehsMissingCount} tone="warning" />
      </div>

      {/* Filter bar - GET form so filters are in the URL */}
      <NavForm
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
      </NavForm>

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
                  <TH>Learning</TH>
                  <TH>EHS</TH>
                  <TH>Cleared</TH>
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
                  const learningState = taskState(row.clearance, "learning");
                  const ehsState = taskState(row.clearance, "ehs");

                  return (
                    <TR key={row.person.id}>
                      <TD className="font-medium">
                        <Link
                          href={`/volunteers/compliance/${row.person.id}`}
                          className="text-brand-fg underline underline-offset-2 hover:opacity-75"
                        >
                          {row.person.name}
                        </Link>
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
                        {row.isVolunteer && row.clearance.tasks.some((t) => t.key === "training") ? (
                          <Badge
                            tone={row.trainingState === "COMPLETE" ? "success" : "default"}
                          >
                            {row.trainingState === "COMPLETE" ? "Complete" : "Pending"}
                          </Badge>
                        ) : (
                          // No designated volunteer training this term -> not required,
                          // so show "-" rather than a misleading "Pending" that
                          // contradicts the Cleared badge.
                          <span className="text-subtle-foreground">-</span>
                        )}
                      </TD>
                      <TD>
                        {learningState ? (
                          <Badge tone={TASK_STATE_TONE[learningState]}>{TASK_STATE_LABEL[learningState]}</Badge>
                        ) : (
                          <span className="text-subtle-foreground">-</span>
                        )}
                      </TD>
                      <TD>
                        {ehsState ? (
                          <Badge tone={TASK_STATE_TONE[ehsState]}>{TASK_STATE_LABEL[ehsState]}</Badge>
                        ) : (
                          <span className="text-subtle-foreground">-</span>
                        )}
                      </TD>
                      <TD>
                        <Badge tone={row.clearance.cleared ? "success" : "critical"}>
                          {row.clearance.cleared ? "Cleared" : "Not cleared"}
                        </Badge>
                      </TD>
                      <TD className="text-foreground-soft tabular-nums">
                        <CalendarDate value={row.cert?.completionDate} />
                      </TD>
                      <TD className="text-foreground-soft tabular-nums">
                        <CalendarDate value={expiresAt} />
                      </TD>
                      <TD className="text-foreground-soft text-xs">
                        {row.cert?.verifiedAt ? (
                          <span>
                            {row.verifiedByName} <DateOnly value={row.cert.verifiedAt} />
                          </span>
                        ) : (
                          "-"
                        )}
                      </TD>
                      <TD>
                        <div className="flex items-center gap-2">
                          {row.cert && (
                            <CertificateViewer
                              certId={row.cert.id}
                              fileName={row.cert.fileName}
                              ownerName={row.person.name}
                              completionDate={row.cert.completionDate}
                              canEditDate
                              canEditExistingDate={isAdmin}
                              onSetDate={setDateAction.bind(null, row.cert.id)}
                              canVerify
                              verified={Boolean(row.cert.verifiedAt)}
                              onVerify={verifyAction.bind(null, row.cert.id)}
                            />
                          )}
                        </div>
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
