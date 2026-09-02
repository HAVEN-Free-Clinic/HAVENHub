/**
 * People directory: the clinic's headcount, where it sits, and how to reach it.
 *
 * Access: EITHER volunteers.view_directory (the Executive Director's clinic-wide
 * grant) or volunteers.view_directory_own_dept (the Director baseline, scoped to
 * the departments the person directs). The volunteers layout gates on module
 * access, which both permissions also grant (registry.ts
 * additionalAccessPermissions), so the page re-checks for defense in depth
 * exactly as /volunteers/master does -- someone holding only volunteers.view is
 * admitted by the layout and must still be bounced here.
 *
 * Which of the two the viewer holds decides how much of the clinic this page
 * shows, and that decision is made ONCE, by directoryScopeFor, then handed to
 * every query. The counts, the department table, the roster, the address list
 * and the CSV all take it, so none of them can be wider than the others.
 *
 * Read-only by design. Nothing on this page edits a person; the export is the
 * one action, and it is audited server-side.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAnyPermission } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { Card } from "@/platform/ui/card";
import { StatCard } from "@/platform/ui/stat-card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Pagination } from "@/platform/ui/pagination";
import { Field, Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Badge } from "@/platform/ui/badge";
import { Button, buttonClasses } from "@/platform/ui/button";
import { NavForm } from "@/platform/ui/nav-form";
import { Alert } from "@/platform/ui/alert";
import { EmailList } from "@/platform/ui/email-list";
import { DirectoryExportButton } from "@/modules/volunteers/components/directory-export-button";
import {
  directorySummary,
  departmentBreakdown,
  directoryPeople,
  directoryEmails,
  directoryAttendings,
  directoryScopeFor,
  type DirectoryFilters,
} from "@/modules/volunteers/services/directory";

const PAGE_SIZE = 50;

type PageProps = {
  searchParams: Promise<{
    q?: string;
    departmentId?: string;
    kind?: string;
    page?: string;
  }>;
};

export default async function DirectoryPage({ searchParams }: PageProps) {
  const viewer = await requireAnyPermission([
    "volunteers.view_directory",
    "volunteers.view_directory_own_dept",
  ]);
  const scope = await directoryScopeFor(viewer.personId);
  // A scoped grant that resolves to no department opens an empty page, which is
  // the dead-end-result shape this codebase has shipped four times. It should
  // not be reachable -- the Director role is kind-targeted, so holding the
  // grant means holding a directorship -- but a hand-made role assignment could
  // manage it, and /no-access explains itself where a blank roster does not.
  if (scope && scope.departmentIds.length === 0) redirect("/no-access");
  const { q, departmentId, kind: kindParam, page: pageParam } = await searchParams;

  // Validated before it reaches a Prisma enum filter; anything else is "no
  // role filter" rather than an error, since it can only arrive by hand-editing
  // the URL.
  const kind =
    kindParam === "DIRECTOR" || kindParam === "VOLUNTEER" ? kindParam : undefined;
  const pageNum = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const filters: DirectoryFilters = {
    ...(departmentId ? { departmentId } : {}),
    ...(kind ? { kind } : {}),
    ...(q?.trim() ? { q: q.trim() } : {}),
  };

  const activeTerm = await getActiveTerm();
  const termId = activeTerm?.id ?? null;

  const [summary, breakdown, people, emails, attendings, departments, canOpenProfile] =
    await Promise.all([
      directorySummary(termId, scope),
      departmentBreakdown(termId, scope),
      directoryPeople(termId, filters, scope, pageNum, PAGE_SIZE),
      directoryEmails(termId, filters, scope),
      directoryAttendings(scope),
      prisma.department.findMany({
        // The picker offers only what the viewer may select. A scoped director
        // choosing someone else's department from a full list would get an
        // empty roster and no reason for it.
        where: scope ? { id: { in: scope.departmentIds } } : {},
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      }),
      // The name below links to the compliance profile ONLY for a viewer who can
      // open it. An Executive Director holding just volunteers.view_directory
      // cannot, and a link that bounces them to /no-access is the dead-end-result
      // bug this codebase has already shipped four times.
      can(viewer.personId, "volunteers.manage_compliance"),
    ]);

  const seatTotal = breakdown.reduce((sum, row) => sum + row.total, 0);
  const hasFilters = Boolean(q || departmentId || kind);
  const showsOtherSeats = people.rows.some((p) => p.otherSeats.length > 0);
  // Named rather than repeated as `scope !== null`: every section below asks
  // the same question, and the answer reads better as what it means.
  const clinicWide = scope === null;
  const scopeCodes = breakdown.map((row) => row.code).join(", ");
  // The header says WHOSE directory this is, because the same page answers "the
  // clinic" for an Executive Director and "your departments" for a director,
  // and a headcount the reader cannot place is worse than none.
  const scopeLabel = clinicWide
    ? "across the clinic"
    : `for ${scopeCodes || "your departments"}`;
  const headerDescription = activeTerm
    ? `Headcount and contact details ${scopeLabel}, ${activeTerm.name}.`
    : `Headcount and contact details ${scopeLabel}.`;

  function hrefFor(targetPage: number): string {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (departmentId) params.set("departmentId", departmentId);
    if (kind) params.set("kind", kind);
    if (targetPage > 1) params.set("page", String(targetPage));
    const s = params.toString();
    return `/volunteers/directory${s ? `?${s}` : ""}`;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="People directory" description={headerDescription} />

      {!activeTerm && (
        <Alert tone="warning">
          No term is active, so there is no roster to show. Membership is
          term-scoped: activate a term in Admin and the directory fills in.
          {clinicWide
            ? " Attendings are listed below regardless -- they are faculty and hold no membership."
            : ""}
        </Alert>
      )}

      {/* Distinct PEOPLE, not seats. See the service's module comment.
          A scoped viewer gets four tiles, not five: attendings are faculty who
          belong to no department, so there is no such thing as "your" share of
          them and a zero would read as a bug rather than as a boundary. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Active people" value={summary.activePeople} tone="brand" />
        <StatCard label="Directors" value={summary.directors} />
        <StatCard label="Volunteers" value={summary.volunteers} />
        <StatCard label="Departments staffed" value={summary.departmentsStaffed} />
        {clinicWide && <StatCard label="Attendings" value={summary.attendings} />}
      </div>

      {/* The one number on this page that looks like an error and is not.
          Rendered only when the overlap actually exists, so a clinic with no
          dual-role members never sees a caveat about a case it does not have. */}
      {summary.bothRoles > 0 && (
        <p className="text-xs text-subtle-foreground">
          Directors and Volunteers overlap by {summary.bothRoles}{" "}
          {summary.bothRoles === 1 ? "person" : "people"} who hold both roles in
          different departments, so the two counts add up to more than Active
          people. The department table below counts filled roles, not people, for
          the same reason: {seatTotal.toLocaleString()} roles across{" "}
          {summary.activePeople.toLocaleString()} people.
        </p>
      )}

      <Card>
        <SectionHeader>By department</SectionHeader>
        <p className="mt-1 text-xs text-subtle-foreground">
          Filled roles this term. Someone in two departments is counted in both.
          Select a row to filter the roster below.
        </p>
        <div className="mt-3 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Department</TH>
                <TH>Directors</TH>
                <TH>Volunteers</TH>
                <TH>Total</TH>
              </TR>
            </THead>
            <tbody>
              {breakdown.map((row) => (
                <TR key={row.departmentId}>
                  <TD className="font-medium">
                    <Link
                      href={`/volunteers/directory?departmentId=${row.departmentId}`}
                      className="text-brand-fg underline underline-offset-2 hover:opacity-75"
                    >
                      {row.code}
                    </Link>
                    <span className="block text-xs font-normal text-subtle-foreground">
                      {row.name}
                    </span>
                  </TD>
                  <TD className="text-foreground-soft">{row.directors}</TD>
                  <TD className="text-foreground-soft">{row.volunteers}</TD>
                  <TD className="font-medium">{row.total}</TD>
                </TR>
              ))}
              <TR>
                <TD className="font-medium">
                  {clinicWide ? "All departments" : "Your departments"}
                </TD>
                <TD className="font-medium">
                  {breakdown.reduce((s, r) => s + r.directors, 0)}
                </TD>
                <TD className="font-medium">
                  {breakdown.reduce((s, r) => s + r.volunteers, 0)}
                </TD>
                <TD className="font-medium">{seatTotal}</TD>
              </TR>
            </tbody>
          </Table>
        </div>
      </Card>

      <Card>
        <SectionHeader>Roster</SectionHeader>

        <NavForm
          action="/volunteers/directory"
          className="mt-3 flex flex-wrap items-end gap-3"
        >
          <div className="min-w-48 flex-1">
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
                {/* "All departments" would overpromise for a scoped viewer,
                    whose list holds only the ones they direct. */}
                <option value="">
                  {clinicWide ? "All departments" : "All your departments"}
                </option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code} - {d.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-40">
            <Field label="Role">
              <Select name="kind" defaultValue={kind ?? ""}>
                <option value="">All roles</option>
                <option value="DIRECTOR">Directors</option>
                <option value="VOLUNTEER">Volunteers</option>
              </Select>
            </Field>
          </div>
          <Button type="submit" variant="primary" size="sm">
            Filter
          </Button>
          {hasFilters && (
            <Link href="/volunteers/directory" className={buttonClasses("outline", "sm")}>
              Clear
            </Link>
          )}
        </NavForm>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
          <p className="text-sm text-muted-foreground">
            {people.total.toLocaleString()}{" "}
            {people.total === 1 ? "person" : "people"}
            {hasFilters ? " matching these filters" : ""}
          </p>
          {/* Exports exactly what the filters select, so "everyone", "one
              department" and "directors only" are all this one button. */}
          <DirectoryExportButton
            label="Export CSV"
            disabled={people.total === 0}
            body={{ scope: "people", departmentId, kind, q }}
          />
        </div>

        {/* The addresses, in one paste.
            The CSV above already carried them, but "mail every SCTM" should not
            require a download, a spreadsheet and a column copied out of it --
            which is exactly how directors described doing it. Same filters as
            the table and the CSV, so the department picker and the role picker
            are how you narrow it, and EVERY match rather than this page's fifty:
            a list that silently stopped at the page boundary would be worse than
            no list at all. */}
        <div className="mt-4 rounded-xl border border-border-subtle bg-muted px-3 py-3">
          <EmailList
            emails={emails}
            label="Email addresses"
            rows={4}
            hint={
              hasFilters
                ? "Everyone matching these filters, across every page."
                : `Everyone on the roster ${clinicWide ? "clinic-wide" : `in ${scopeCodes}`}. Narrow it with the filters above.`
            }
            emptyLabel={
              !activeTerm
                ? "No active term, so nobody holds a membership to mail."
                : "Nobody matches these filters."
            }
          />
        </div>

        {/* Without this, the "also" lines read as a filter that leaks: the row
            was selected on one department and is showing another. Say once that
            they are context, not matches. Rendered only when a row actually has
            one, so an unfiltered roster carries no caveat about a case it does
            not have. */}
        {showsOtherSeats && (
          <p className="mt-2 text-xs text-subtle-foreground">
            Some of these people also serve outside these filters. Their other
            departments are listed under &quot;also&quot;, with the role held
            there, so a two-department member does not read as a one-department
            member.
          </p>
        )}

        <div className="mt-3 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Departments</TH>
                <TH>Role</TH>
              </TR>
            </THead>
            <tbody>
              {people.rows.map((p) => {
                const codes = [...new Set(p.seats.map((s) => s.departmentCode))];
                // The seats the filter did not select, each labeled with the
                // role held there. The Role column can only speak for the
                // matched seats, so this line is the only place a Nursing
                // director's Triage volunteering survives a Nursing filter.
                const alsoIn = p.otherSeats.map(
                  (s) =>
                    `${s.departmentCode} (${s.kind === "DIRECTOR" ? "Director" : "Volunteer"})`,
                );
                const isDirector = p.seats.some((s) => s.kind === "DIRECTOR");
                const isVolunteer = p.seats.some((s) => s.kind === "VOLUNTEER");
                return (
                  <TR key={p.id}>
                    {/* NetID, email and phone sit under the name rather than in
                        columns of their own, matching /volunteers/master, which
                        already presents a clinic-wide roster this way. */}
                    <TD className="font-medium">
                      {canOpenProfile ? (
                        <Link
                          href={`/volunteers/compliance/${p.id}`}
                          className="text-brand-fg underline underline-offset-2 hover:opacity-75"
                        >
                          {p.name}
                        </Link>
                      ) : (
                        p.name
                      )}
                      <span className="block text-xs font-normal text-subtle-foreground break-words [overflow-wrap:anywhere]">
                        {[p.netId, p.contactEmail, p.phone].filter(Boolean).join(" · ") ||
                          "No contact details on file"}
                      </span>
                    </TD>
                    <TD className="text-sm text-foreground-soft">
                      {codes.join(", ")}
                      {alsoIn.length > 0 && (
                        <span className="block text-xs text-subtle-foreground">
                          also {alsoIn.join(", ")}
                        </span>
                      )}
                    </TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {isDirector && <Badge tone="brand">Director</Badge>}
                        {isVolunteer && <Badge>Volunteer</Badge>}
                      </div>
                    </TD>
                  </TR>
                );
              })}
              {people.rows.length === 0 && (
                <TR>
                  <TD colSpan={3} className="py-10 text-center text-subtle-foreground">
                    {!activeTerm
                      ? "No active term, so nobody holds a membership to list."
                      : hasFilters
                        ? "Nobody matches these filters."
                        : "Nobody is on the roster this term yet."}
                  </TD>
                </TR>
              )}
            </tbody>
          </Table>
        </div>

        <Pagination page={people.page} pageCount={people.pageCount} hrefFor={hrefFor} />
      </Card>

      {/* Clinic-wide only. Attendings are faculty: they hold no membership and
          belong to no department, so a department-scoped grant cannot reach
          them, and a director's Saturday attending is already named on the
          builder's readiness panel. The service returns an empty list for a
          scoped viewer regardless of what this renders. */}
      {clinicWide && (
        <Card>
          <SectionHeader>Attendings</SectionHeader>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-subtle-foreground">
              Attending Faculty: they hold no membership and belong to no
              department, so they are counted and exported separately from the
              roster above.
            </p>
            <DirectoryExportButton
              label="Export attendings"
              disabled={attendings.length === 0}
              body={{ scope: "attendings" }}
            />
          </div>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Specialty</TH>
                  <TH>Contact</TH>
                </TR>
              </THead>
              <tbody>
                {attendings.map((a) => (
                  <TR key={a.id}>
                    <TD className="font-medium">
                      {a.fullName}
                      {a.credentials && (
                        <span className="block text-xs font-normal text-subtle-foreground">
                          {a.credentials}
                        </span>
                      )}
                    </TD>
                    <TD className="text-sm text-foreground-soft">{a.specialty ?? "-"}</TD>
                    <TD className="text-sm text-foreground-soft break-words [overflow-wrap:anywhere]">
                      {[a.email, a.phone].filter(Boolean).join(" · ") || "-"}
                    </TD>
                  </TR>
                ))}
                {attendings.length === 0 && (
                  <TR>
                    <TD colSpan={3} className="py-10 text-center text-subtle-foreground">
                      No active attendings on the roster.
                    </TD>
                  </TR>
                )}
              </tbody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}
