/**
 * People directory: the clinic's headcount, where it sits, and how to reach it.
 *
 * Access: requirePermission("volunteers.view_directory"), the Executive Director
 * role's permission. The volunteers layout gates on module access, which this
 * permission also grants (registry.ts additionalAccessPermissions), so the page
 * re-checks its own permission for defense in depth exactly as /volunteers/master
 * does -- someone holding only volunteers.view is admitted by the layout and must
 * still be bounced here.
 *
 * Read-only by design. Nothing on this page edits a person; the export is the
 * one action, and it is audited server-side.
 */

import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
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
import { DirectoryExportButton } from "@/modules/volunteers/components/directory-export-button";
import {
  directorySummary,
  departmentBreakdown,
  directoryPeople,
  directoryAttendings,
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
  const viewer = await requirePermission("volunteers.view_directory");
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

  const [summary, breakdown, people, attendings, departments, canOpenProfile] =
    await Promise.all([
      directorySummary(termId),
      departmentBreakdown(termId),
      directoryPeople(termId, filters, pageNum, PAGE_SIZE),
      directoryAttendings(),
      prisma.department.findMany({
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
      <PageHeader
        title="People directory"
        description={
          activeTerm
            ? `Headcount and contact details across the clinic for ${activeTerm.name}.`
            : "Headcount and contact details across the clinic."
        }
      />

      {!activeTerm && (
        <Alert tone="warning">
          No term is active, so there is no roster to show. Membership is
          term-scoped: activate a term in Admin and the directory fills in.
          Attendings are listed below regardless -- they are faculty and hold no
          membership.
        </Alert>
      )}

      {/* Distinct PEOPLE, not seats. See the service's module comment. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Active people" value={summary.activePeople} tone="brand" />
        <StatCard label="Directors" value={summary.directors} />
        <StatCard label="Volunteers" value={summary.volunteers} />
        <StatCard label="Departments staffed" value={summary.departmentsStaffed} />
        <StatCard label="Attendings" value={summary.attendings} />
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
                <TD className="font-medium">All departments</TD>
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
                <option value="">All departments</option>
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
                    <TD className="text-sm text-foreground-soft">{codes.join(", ")}</TD>
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
    </div>
  );
}
