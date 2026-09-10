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
import { Table, THead, TR, TH, TD, TableEmpty } from "@/platform/ui/table";
import { ListEmpty } from "@/platform/ui/list-empty";
import {
  COMPLIANCE_COLUMN_COUNT,
  ComplianceHeaderCells,
  ComplianceCells,
} from "@/modules/volunteers/components/compliance-cells";
import { PersonNameCell } from "@/modules/volunteers/components/person-name-cell";
import { Pagination } from "@/platform/ui/pagination";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { StatCard } from "@/platform/ui/stat-card";
import { FilterBar, FilterField } from "@/platform/ui/filter-bar";
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
import {
  complianceStatusLabel,
  ALL_COMPLIANCE_STATUSES as ALL_STATUSES,
} from "@/platform/compliance/labels";
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
        title="Master view"
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
  // One boolean for the Clear link AND the empty state, so the roster cannot
  // offer to clear a filter while claiming there is nothing to find.
  const filtered = Boolean(q || departmentId || statusFilter);
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
      {/* One tile per status, labelled and toned from the shared vocabulary so a
          tile, the badge in its row and the filter option below all agree. */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {ALL_STATUSES.map((s) => {
          const { label, tone } = complianceStatusLabel(s, "staff");
          return <StatCard key={s} label={label} value={result.summary[s]} tone={tone} />;
        })}
      </div>

      {/* Clearance summary (full clearance, not just HIPAA) */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <StatCard label="Fully cleared" value={result.clearedCount} tone="success" />
        <StatCard label="Missing EHS" value={result.ehsMissingCount} tone="warning" />
      </div>

      {/* Filter bar - GET form so filters are in the URL */}
      <FilterBar
        action="/volunteers/master"
        clearHref={filtered ? "/volunteers/master" : undefined}
        resultCount={{ total: result.total, noun: "member" }}
        className="mt-6"
      >
        <FilterField label="Search" width="grow">
          <Input type="search" name="q" defaultValue={q ?? ""} placeholder="Name, NetID, or email…" />
        </FilterField>
        <FilterField label="Department" width="wide">
          <Select name="departmentId" defaultValue={departmentId ?? ""}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} - {d.name}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Status">
          <Select name="status" defaultValue={statusFilter ?? ""}>
            <option value="">All statuses</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {complianceStatusLabel(s, "staff").label}
              </option>
            ))}
          </Select>
        </FilterField>
      </FilterBar>

      {/* Results */}
      <div className="mt-4">

        <>
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Departments</TH>
                  <ComplianceHeaderCells />
                  <TH><span className="sr-only">Actions</span></TH>
                </TR>
              </THead>
              <tbody>
                {result.rows.map((row) => {
                  return (
                    <TR key={row.person.id}>
                      <PersonNameCell
                        person={row.person}
                        href={`/volunteers/compliance/${row.person.id}`}
                      />
                      <TD className="text-foreground-soft text-sm">
                        {row.departments.join(", ")}
                      </TD>
                      <ComplianceCells row={row} />
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
                {result.rows.length === 0 && (
                  <TableEmpty colSpan={COMPLIANCE_COLUMN_COUNT + 3}>
                    <ListEmpty filtered={filtered} noun="members" />
                  </TableEmpty>
                )}
              </tbody>
            </Table>

            {result.rows.length > 0 && (
              <div className="mt-4">
                <Pagination
                  page={result.page}
                  pageCount={result.pageCount}
                  hrefFor={buildHref}
                />
              </div>
            )}
          </>
      </div>
    </>
  );
}
