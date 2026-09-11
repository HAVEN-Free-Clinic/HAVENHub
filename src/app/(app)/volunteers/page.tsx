/**
 * /volunteers: the module root, and the one compliance roster.
 *
 * There used to be two rosters of the same people one tab apart. This page was
 * a director's per-department cards, with no search, no paging and no Learning
 * column; /volunteers/master was the clinic-wide table with all three. The two
 * disagreed about whether a volunteer was cleared (the directors' copy never
 * showed Learning), and a director of a large department could not search it.
 *
 * One table now serves both audiences, scoped by who is looking:
 *   - volunteers.view_compliance / manage_compliance: every active member
 *   - volunteers.view, i.e. a department director: the departments they direct
 *     plus one-hop delegations (manageableDepartmentIds), the same set the old
 *     cards showed and the per-person profile admits
 * /volunteers/master redirects here with its query intact.
 *
 * Every write control (verify, set a completion date) hangs off
 * volunteers.manage_compliance, and the server actions enforce it again: a
 * director reads their roster, a compliance manager attests it.
 *
 * Suspense-streamed, with a skeleton that carries the real labels: this roster
 * has measured CLS as high as 0.8 and cold loads with an 11s p75, so the filter
 * row and table are placeholders rather than painted-but-unwired controls.
 */

import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requirePermission, requirePersonSession } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getNextTerm } from "@/platform/terms/next-term";
import { buildTermOptions } from "@/platform/terms/term-options";
import { manageableDepartmentIds } from "@/platform/departments";
import { TermSwitcher } from "@/platform/ui/term-switcher";
import { Alert } from "@/platform/ui/alert";
import { can } from "@/platform/rbac/engine";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD, TableEmpty, SortableTH } from "@/platform/ui/table";
import { ListEmpty } from "@/platform/ui/list-empty";
import { nextDirection, parseSort, type Sort, type SortDirection } from "@/platform/lists/sort";
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
  MASTER_SORT_KEYS,
  type MasterSortKey,
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
import { ComplianceRosterSkeleton } from "./roster-skeleton";
import { CLINIC_WIDE_ROSTER_PERMISSIONS, VOLUNTEER_ENTRY_FALLBACKS } from "./module-entry";

const ROSTER_PATH = "/volunteers";

type PageProps = {
  searchParams: Promise<{
    q?: string;
    departmentId?: string;
    status?: string;
    page?: string;
    sort?: string;
    dir?: string;
    term?: string;
  }>;
};

/** Direction each sortable column opens in on its first click. Both are people
 *  columns read alphabetically, so both open ascending. */
const SORT_DEFAULTS: Record<MasterSortKey, SortDirection> = {
  name: "asc",
  departments: "asc",
};

/** Above this, a roster load is worth a log line. Chosen off the measured
 *  distribution: healthy loads land near 1.5s, the bad tail is above 10s, so
 *  2.5s catches the tail without logging every render. */
const SLOW_RENDER_MS = 2_500;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function VolunteersPage({ searchParams }: PageProps) {
  // Who opens the roster, decided in the shell ahead of the Suspense boundary
  // so an unauthorized viewer is bounced rather than shown a header and a
  // skeleton first.
  const session = await requirePersonSession();
  const [clinicWideGrants, isDirectorViewer] = await Promise.all([
    Promise.all(CLINIC_WIDE_ROSTER_PERMISSIONS.map((p) => can(session.personId, p))),
    can(session.personId, "volunteers.view"),
  ]);
  const clinicWide = clinicWideGrants.some(Boolean);

  // This page is the module root, where the tile, the chip and the crumb point,
  // but the module admits more personas than the roster does. Send each to the
  // first tab they would see (module-entry.ts); anyone left is bounced by the
  // permission check.
  if (!clinicWide && !isDirectorViewer) {
    for (const [permission, href] of VOLUNTEER_ENTRY_FALLBACKS) {
      if (await can(session.personId, permission)) redirect(href);
    }
    await requirePermission("volunteers.view");
  }

  // undefined = the whole clinic. A director's scope can be empty: roles that
  // grant volunteers.view do not all direct a department this term.
  const scope = clinicWide ? undefined : await manageableDepartmentIds(session.personId);
  const description = scope
    ? "Clearance status for the departments you direct: HIPAA, training, learning, and EHS."
    : "Clearance status across every active clinic member: HIPAA, training, learning, and EHS.";

  if (scope && scope.length === 0) {
    return (
      <div>
        <PageHeader title="Compliance" description={description} />
        <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
          <p>You are not listed as a director of any department this term.</p>
        </div>
      </div>
    );
  }

  const sp = await searchParams;
  const q = sp.q?.trim() || undefined;
  const departmentId = sp.departmentId || undefined;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const rawStatus = sp.status;
  const statusFilter: ComplianceStatus | undefined =
    rawStatus && (ALL_STATUSES as string[]).includes(rawStatus)
      ? (rawStatus as ComplianceStatus)
      : undefined;
  const sort = parseSort(sp.sort, sp.dir, MASTER_SORT_KEYS);

  // Whose roster: the live term, or the next one before it goes live, which is
  // when the certificates promotion collected need verifying. Only the next
  // term is accepted, so a stale or hand-typed ?term= reads as the live roster.
  const [liveTerm, nextTerm] = await Promise.all([getActiveTerm(), getNextTerm()]);
  const termId = nextTerm && sp.term === nextTerm.id ? nextTerm.id : undefined;

  // Keying the boundary on the filters is what makes applying a filter feel
  // like it did something. Without it React holds the resolved roster on screen
  // while the new one loads, which is how a "Filter" click reads as dead for the
  // seconds the query takes. A sort click reorders the same slow query, so it
  // belongs in the key for the same reason.
  const filterKey = [
    termId ?? "",
    q ?? "",
    departmentId ?? "",
    statusFilter ?? "",
    page,
    sort ? `${sort.key}:${sort.dir}` : "",
  ].join("|");

  return (
    <div>
      <PageHeader title="Compliance" description={description} />
      {liveTerm && nextTerm && (
        <div className="mt-4 space-y-3">
          <TermSwitcher
            options={buildTermOptions([liveTerm, nextTerm])}
            selectedId={termId ?? liveTerm.id}
            liveTermId={liveTerm.id}
            hrefForTerm={(id) => (id ? `${ROSTER_PATH}?term=${id}` : ROSTER_PATH)}
          />
          {termId && (
            <Alert tone="info">
              Showing {nextTerm.name}, which is not active yet: everyone promoted onto its roster.
              Verify their certificates here before it goes live. From that moment the onboarding
              gate holds anyone without a verified one.
            </Alert>
          )}
        </div>
      )}
      <Suspense key={filterKey} fallback={<ComplianceRosterSkeleton />}>
        <RosterBody
          viewerPersonId={session.personId}
          scope={scope}
          termId={termId}
          q={q}
          departmentId={departmentId}
          statusFilter={statusFilter}
          page={page}
          sort={sort}
        />
      </Suspense>
    </div>
  );
}

type BodyProps = {
  viewerPersonId: string;
  /** The departments the viewer may see; undefined for the whole clinic. */
  scope: string[] | undefined;
  /** The next term's id when that roster was asked for; undefined means live. */
  termId: string | undefined;
  q: string | undefined;
  departmentId: string | undefined;
  statusFilter: ComplianceStatus | undefined;
  page: number;
  sort: Sort<MasterSortKey> | null;
};

/** Departments on the shown roster, for the filter select, held to the
 *  viewer's scope so a director is never offered a department they cannot see.
 *  Its own function so it runs alongside the roster query; getActiveTerm is
 *  request-cached, so resolving it here costs nothing masterCompliance has not
 *  paid. */
async function rosterDepartments(termId: string | undefined, scope: string[] | undefined) {
  const id = termId ?? (await getActiveTerm())?.id;
  if (!id) return [];
  return prisma.department.findMany({
    where: {
      memberships: { some: { termId: id, status: "ACTIVE" } },
      ...(scope ? { id: { in: scope } } : {}),
    },
    orderBy: { code: "asc" },
  });
}

/**
 * Everything the body renders from, fetched together: the four calls are
 * independent. It lives outside the component because Date.now() is impure and
 * the purity lint (rightly) refuses it during render, and the timing belongs to
 * the fetch. Slow loads are logged with the scope size so the next pass can
 * target a query instead of a hunch.
 */
async function loadBodyData({ viewerPersonId, scope, termId, q, departmentId, statusFilter, page, sort }: BodyProps) {
  const startedAt = Date.now();
  const [result, departments, isAdmin, isManager] = await Promise.all([
    masterCompliance({
      termId,
      q,
      departmentId,
      status: statusFilter,
      page,
      pageSize: 25,
      sort: sort ?? undefined,
      scopeDepartmentIds: scope,
    }),
    rosterDepartments(termId, scope),
    can(viewerPersonId, "admin.access"),
    // Attesting is manage-only. A director or a view_compliance holder is
    // admitted for the READ, so every write affordance below hangs off this
    // instead of being unconditionally on. The server actions enforce it again
    // anyway; this is what stops the page offering a button that can only fail.
    can(viewerPersonId, "volunteers.manage_compliance"),
  ]);
  const elapsedMs = Date.now() - startedAt;

  if (elapsedMs > SLOW_RENDER_MS) {
    log.info("[volunteers] slow roster load", {
      elapsedMs,
      total: result.total,
      rows: result.rows.length,
      page,
      scoped: Boolean(scope),
      filtered: Boolean(q || departmentId || statusFilter),
    });
  }

  return { result, departments, isAdmin, isManager };
}

async function RosterBody(props: BodyProps) {
  const { termId, q, departmentId, statusFilter, sort } = props;
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
    revalidatePath(ROSTER_PATH);
    return {};
  }

  // Server action: verify a certificate. certId is bound per-row. Gated to
  // volunteers.manage_compliance. verifyCertificate treats manage_compliance as
  // a master key, so a ComplianceForbiddenError is defensive; it is surfaced in
  // the viewer modal like setDateAction's errors.
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
    revalidatePath(ROSTER_PATH);
    return {};
  }

  // Every roster link carries the full state, so neither a filter nor the sort
  // is dropped by navigating. Page is left implicit for page 1, which is also
  // how a header link asks for "sorted, from the top".
  function buildHref(parts: { page: number | null; sort: Sort<MasterSortKey> | null }): string {
    const params = new URLSearchParams();
    if (termId) params.set("term", termId);
    if (q) params.set("q", q);
    if (departmentId) params.set("departmentId", departmentId);
    if (statusFilter) params.set("status", statusFilter);
    if (parts.sort) {
      params.set("sort", parts.sort.key);
      params.set("dir", parts.sort.dir);
    }
    if (parts.page && parts.page > 1) params.set("page", String(parts.page));
    const query = params.toString();
    return query ? `${ROSTER_PATH}?${query}` : ROSTER_PATH;
  }

  // Re-sorting returns to page 1: the row a manager was looking at on page 4 is
  // not on page 4 of a different order, so holding the page number there would
  // land them somewhere arbitrary. Matches the applicants roster.
  const sortHref = (key: MasterSortKey) =>
    buildHref({ page: null, sort: { key, dir: nextDirection(sort, key, SORT_DEFAULTS) } });

  return (
    <>
      {/* One tile per status, labelled and toned from the shared vocabulary so a
          tile, the badge in its row and the filter option below all agree.
          Not on a phone: six tiles plus the two below stacked into four rows
          of two before the first person, and the Status filter right under
          them carries the same breakdown. The clearance pair stays. */}
      <div className="mt-6 hidden gap-3 sm:grid sm:grid-cols-3 lg:grid-cols-6">
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
        action={ROSTER_PATH}
        clearHref={filtered ? (termId ? `${ROSTER_PATH}?term=${termId}` : ROSTER_PATH) : undefined}
        resultCount={{ total: result.total, noun: "member" }}
        className="mt-6"
      >
        {/* Hidden, so filtering a sorted roster keeps the order the viewer chose
            instead of silently snapping back to the default. */}
        {sort && <input type="hidden" name="sort" value={sort.key} />}
        {sort && <input type="hidden" name="dir" value={sort.dir} />}
        {/* Filtering the next term's roster must not snap back to the live one. */}
        {termId && <input type="hidden" name="term" value={termId} />}
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

      {/* On production every row read "-" under Training and Learning, which
          looked like missing data. It is not: the item does not apply to that
          person this term (no designated training, no required course). */}
      <p className="mt-4 text-xs text-subtle-foreground">
        A dash under Training, Learning or EHS means that item is not required for that person this term.
      </p>

      <div className="mt-2">
        <Table>
          <THead>
            <TR>
              {/* Only these two are sortable, and only these two are worth it:
                  the eight compliance headers beside them hold two- and
                  three-valued badges that the Status select already filters on. */}
              <SortableTH columnKey="name" active={sort} hrefFor={sortHref}>
                Name
              </SortableTH>
              <SortableTH columnKey="departments" active={sort} hrefFor={sortHref}>
                Departments
              </SortableTH>
              <ComplianceHeaderCells />
              <TH><span className="sr-only">Actions</span></TH>
            </TR>
          </THead>
          <tbody>
            {result.rows.map((row) => (
              <TR key={row.person.id}>
                {/* Every row is by construction inside the viewer's scope, which
                    is exactly the profile page's own scope, so no link can bounce. */}
                <PersonNameCell person={row.person} href={`/volunteers/compliance/${row.person.id}`} />
                <TD className="text-foreground-soft text-sm">{row.departments.join(", ")}</TD>
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
            ))}
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
              hrefFor={(targetPage) => buildHref({ page: targetPage, sort })}
            />
          </div>
        )}
      </div>
    </>
  );
}
