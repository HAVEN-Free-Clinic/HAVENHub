/**
 * Master compliance view: all active members across the clinic in the active term.
 *
 * Access: requireAnyPermission(["volunteers.view_compliance",
 * "volunteers.manage_compliance"]) -- this page is a clinic-wide READ, so either
 * half of the compliance split admits. What separates the two viewers is the
 * controls, not the table: `isManager` below gates every write affordance (the
 * verify button and the completion-date entry inside CertificateViewer), so a
 * view-only holder reads the same roster with nothing to press. The server
 * actions re-check manage_compliance through the service layer regardless, so
 * hiding the control is presentation, not the security boundary.
 *
 * NOTE on layout/permission layering:
 *   The volunteers layout uses canAccessModule("volunteers"), whose access set
 *   includes both compliance permissions, so holders of either pass both checks.
 *   This page still enforces its own gate for defense in depth - someone with
 *   volunteers.view and neither compliance permission is admitted by the layout
 *   and must be bounced here.
 *
 * NOTE on streaming:
 *   Everything below the header is behind a Suspense boundary. This route was
 *   the slowest in the app on a cold load -- p75 first contentful paint of 11s
 *   against 2.3s for the next-worst route -- because it was one blocking server
 *   component: nothing at all painted until masterCompliance() had resolved
 *   clearance for the whole roster. FCP and LCP tracked each other to within a
 *   few hundred ms on every measured day, which is the signature of a page that
 *   arrives in one piece. Splitting the header into a fast shell lets the
 *   browser paint immediately and lets React hydrate the shell while the roster
 *   is still resolving, so a click that lands during the wait hits a
 *   placeholder rather than a control that is painted but not yet wired.
 */

import { Suspense } from "react";
import { requireAnyPermission, requirePermission } from "@/platform/auth/session";
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
import { log } from "@/platform/logging";
import { MasterComplianceSkeleton } from "./master-skeleton";

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

/** Above this, a roster load is worth a log line. Chosen off the measured
 *  distribution: healthy loads of this page land near 1.5s, the bad tail is
 *  above 10s, so 2.5s catches the tail without logging every render. */
const SLOW_RENDER_MS = 2_500;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function MasterCompliancePage({ searchParams }: PageProps) {
  // Page-level permission gate. The layout admits on module access; this adds
  // the clinic-wide compliance read on top of it. Either half of the split
  // admits, because the table itself is a read. It stays in the shell, ahead of
  // the Suspense boundary, so an unauthorized viewer is still bounced rather
  // than shown a header and a skeleton first.
  const viewer = await requireAnyPermission([
    "volunteers.view_compliance",
    "volunteers.manage_compliance",
  ]);
  const sp = await searchParams;

  const q = sp.q?.trim() || undefined;
  const departmentId = sp.departmentId || undefined;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const rawStatus = sp.status;
  const statusFilter: ComplianceStatus | undefined =
    rawStatus && (ALL_STATUSES as string[]).includes(rawStatus)
      ? (rawStatus as ComplianceStatus)
      : undefined;

  // Keying the boundary on the filters is what makes applying a filter feel
  // like it did something. Without it React holds the resolved roster on screen
  // while the new one loads, which is how a "Filter" click reads as dead for the
  // ten seconds the query takes.
  const filterKey = [q ?? "", departmentId ?? "", statusFilter ?? "", page].join("|");

  return (
    <div>
      <PageHeader
        title="Master compliance view"
        description="Full clearance status across all active clinic members: HIPAA, training, learning, and EHS."
      />
      <Suspense key={filterKey} fallback={<MasterComplianceSkeleton />}>
        <MasterComplianceBody
          viewerPersonId={viewer.personId}
          q={q}
          departmentId={departmentId}
          statusFilter={statusFilter}
          page={page}
        />
      </Suspense>
    </div>
  );
}

type BodyProps = {
  viewerPersonId: string;
  q: string | undefined;
  departmentId: string | undefined;
  statusFilter: ComplianceStatus | undefined;
  page: number;
};

/** Active departments for the filter select. Its own function so it can run
 *  alongside the roster query instead of after it; getActiveTerm is request-
 *  cached, so resolving it here costs nothing masterCompliance has not paid. */
async function activeDepartments() {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return [];
  return prisma.department.findMany({
    where: { memberships: { some: { termId: activeTerm.id, status: "ACTIVE" } } },
    orderBy: { code: "asc" },
  });
}

/**
 * Everything the body renders from, fetched together. The four calls are
 * independent; run serially they stacked three more round trips on top of an
 * already-slow roster query. The roster still dominates, but the other three
 * are now free.
 *
 * It lives outside the component for two reasons. Date.now() is impure and the
 * purity lint (rightly) refuses it during render, and the timing belongs to the
 * fetch rather than to the JSX. The route's cold loads were bimodal -- a 1.5s
 * median against an 11s p75 -- with nothing instrumented server-side, so which
 * of the roughly twenty round trips behind masterCompliance() owns the tail was
 * guesswork. Logging the slow ones with the scope size lets the next pass target
 * a query instead of a hunch. Gated on the threshold because a healthy render is
 * not worth a log line.
 */
async function loadBodyData({ viewerPersonId, q, departmentId, statusFilter, page }: BodyProps) {
  const startedAt = Date.now();
  const [result, departments, isAdmin, isManager] = await Promise.all([
    masterCompliance({ q, departmentId, status: statusFilter, page, pageSize: 25 }),
    activeDepartments(),
    // Admin access links person names to admin pages.
    can(viewerPersonId, "admin.access"),
    // Attesting is manage-only. A view_compliance holder was admitted by the
    // page gate for the READ, so every write affordance below hangs off this
    // instead of being unconditionally on. The server actions enforce it again
    // anyway; this is what stops the page offering a button that can only fail.
    can(viewerPersonId, "volunteers.manage_compliance"),
  ]);
  const elapsedMs = Date.now() - startedAt;

  if (elapsedMs > SLOW_RENDER_MS) {
    log.info("[volunteers/master] slow roster load", {
      elapsedMs,
      total: result.total,
      rows: result.rows.length,
      page,
      filtered: Boolean(q || departmentId || statusFilter),
    });
  }

  return { result, departments, isAdmin, isManager };
}

async function MasterComplianceBody(props: BodyProps) {
  const { q, departmentId, statusFilter } = props;
  const { result, departments, isAdmin, isManager } = await loadBodyData(props);

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
    <>
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
              placeholder="Name, NetID, or email..."
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
                      {/* NetID, email and phone sit under the name rather than
                          in columns of their own: the table already runs eleven
                          wide, and three more would push the clearance badges
                          off screen on any laptop. The full identity is on the
                          profile page the name links to. */}
                      <TD className="font-medium">
                        <Link
                          href={`/volunteers/compliance/${row.person.id}`}
                          className="text-brand-fg underline underline-offset-2 hover:opacity-75"
                        >
                          {row.person.name}
                        </Link>
                        <span className="block text-xs font-normal text-subtle-foreground break-words [overflow-wrap:anywhere]">
                          {[row.person.netId, row.person.contactEmail, row.person.phone]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
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
                              canEditDate={isManager}
                              canEditExistingDate={isAdmin}
                              onSetDate={setDateAction.bind(null, row.cert.id)}
                              canVerify={isManager}
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
    </>
  );
}
