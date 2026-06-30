/**
 * AssignmentForm: server component for the Assignments section on /admin/roles.
 *
 * Renders:
 *  - A table of all current role assignments with a delete ConfirmButton per row
 *  - Person-assignment create form: GET-based search (?assignq=) listing up to 10
 *    matches; each match row has a form with role select, term select, and Assign button
 *  - Department-assignment create form: department select, role select, term select,
 *    Assign department button
 *
 * NOTE: Person merge tooling for duplicate assignment targets is deferred;
 * resolve duplicates in Airtable and re-import.
 */

import type { ReactNode } from "react";
import type { Role, RoleAssignment, Person, Department, Term, MembershipKind } from "@prisma/client";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  createAssignment,
  deleteAssignment,
  AssignmentNotFoundError,
  AssignmentTargetError,
  DuplicateAssignmentError,
  LastAdminError,
} from "@/modules/admin/services/rbac";
import { searchPeople } from "@/modules/admin/services/people";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Input, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { SectionHeader } from "@/platform/ui/section-header";
import { buildTermOptions } from "./term-options";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AssignmentWithRelations = RoleAssignment & {
  role: Role;
  person: Person | null;
  department: Department | null;
  term: Term | null;
};

type AssignmentFormProps = {
  assignments: AssignmentWithRelations[];
  roles: Role[];
  departments: Department[];
  terms: (Term & { _count: { memberships: number } })[];
  /** Current ?assignq= search query for person search. */
  assignq?: string;
  /** Base href for this page. Used for redirect targets. */
  pageHref: string;
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Term scope picker for a role assignment. Options come from buildTermOptions so
 * the dropdown only offers scopes the RBAC engine honors (Global + active term),
 * flags PLANNING terms as not-yet-active, and drops ARCHIVED terms entirely.
 */
function TermSelect({
  terms,
  defaultValue,
}: {
  terms: Pick<Term, "id" | "code" | "status">[];
  defaultValue?: string;
}) {
  return (
    <Select name="termId" defaultValue={defaultValue} className="w-36">
      {buildTermOptions(terms).map((o) => (
        <option key={o.value || "global"} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export async function AssignmentForm({
  assignments,
  roles,
  departments,
  terms,
  assignq,
  pageHref,
}: AssignmentFormProps): Promise<ReactNode> {
  // ---------------------------------------------------------------------------
  // Person search results
  // ---------------------------------------------------------------------------

  let personResults: Person[] = [];
  if (assignq && assignq.trim()) {
    const result = await searchPeople({
      search: assignq.trim(),
      status: "ACTIVE",
      pageSize: 10,
    });
    personResults = result.rows;
  }

  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------

  async function deleteAssignmentAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_roles");
    const id = formData.get("assignmentId") as string | null;
    if (!id) {
      redirect(`${pageHref}?rbacError=${encodeURIComponent("Missing assignment ID.")}`);
    }

    try {
      await deleteAssignment(actor.personId, id);
    } catch (err) {
      if (err instanceof AssignmentNotFoundError) {
        redirect(
          `${pageHref}?rbacError=${encodeURIComponent("Assignment no longer exists; the page may be stale.")}`
        );
      }
      if (err instanceof LastAdminError) {
        redirect(
          `${pageHref}?rbacError=${encodeURIComponent(err.message)}`
        );
      }
      throw err;
    }
    redirect(`${pageHref}?saved=1`);
  }

  async function assignPersonAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_roles");
    const personId = formData.get("personId") as string | null;
    const roleId = formData.get("roleId") as string | null;
    const termIdRaw = formData.get("termId") as string | null;
    const termId = termIdRaw && termIdRaw !== "" ? termIdRaw : undefined;

    if (!personId || !roleId) {
      redirect(
        `${pageHref}?rbacError=${encodeURIComponent("Person and role are required.")}`
      );
    }

    try {
      await createAssignment(actor.personId, { roleId, personId, termId });
    } catch (err) {
      if (err instanceof AssignmentTargetError || err instanceof DuplicateAssignmentError) {
        redirect(
          `${pageHref}?rbacError=${encodeURIComponent(err.message)}`
        );
      }
      throw err;
    }
    // Success: clear assignq with ?saved=1
    redirect(`${pageHref}?saved=1`);
  }

  async function assignDepartmentAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_roles");
    const departmentId = formData.get("departmentId") as string | null;
    const roleId = formData.get("roleId") as string | null;
    const termIdRaw = formData.get("termId") as string | null;
    const termId = termIdRaw && termIdRaw !== "" ? termIdRaw : undefined;

    if (!departmentId || !roleId) {
      redirect(
        `${pageHref}?rbacError=${encodeURIComponent("Department and role are required.")}`
      );
    }

    try {
      await createAssignment(actor.personId, { roleId, departmentId, termId });
    } catch (err) {
      if (err instanceof AssignmentTargetError || err instanceof DuplicateAssignmentError) {
        redirect(
          `${pageHref}?rbacError=${encodeURIComponent(err.message)}`
        );
      }
      throw err;
    }
    redirect(`${pageHref}?saved=1`);
  }

  async function assignKindAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_roles");
    const kind = formData.get("kind") as string | null;
    const roleId = formData.get("roleId") as string | null;
    const termIdRaw = formData.get("termId") as string | null;
    const termId = termIdRaw && termIdRaw !== "" ? termIdRaw : undefined;

    if (!kind || !roleId) {
      redirect(`${pageHref}?rbacError=${encodeURIComponent("Members and role are required.")}`);
    }
    if (kind !== "VOLUNTEER" && kind !== "DIRECTOR") {
      redirect(`${pageHref}?rbacError=${encodeURIComponent("Invalid member kind.")}`);
    }

    try {
      await createAssignment(actor.personId, { roleId: roleId!, kind: kind as MembershipKind, termId });
    } catch (err) {
      if (err instanceof AssignmentTargetError || err instanceof DuplicateAssignmentError) {
        redirect(`${pageHref}?rbacError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`${pageHref}?saved=1`);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const activeTermId = terms.find((t) => t.status === "ACTIVE")?.id ?? "";

  return (
    <section className="space-y-8">
      <SectionHeader level="title" className="mb-4">Assignments</SectionHeader>

      {/* Assignments table */}
      {assignments.length === 0 ? (
        <p className="text-sm text-subtle-foreground">No assignments yet.</p>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Role</TH>
              <TH>Target</TH>
              <TH>Scope</TH>
              <TH />
            </TR>
          </THead>
          <tbody>
            {assignments.map((a) => (
              <TR key={a.id}>
                <TD className="font-medium text-foreground">{a.role.name}</TD>
                <TD>
                  {a.person ? (
                    <span className="flex items-center gap-2">
                      <Badge tone="default">Person</Badge>
                      {a.person.name}
                    </span>
                  ) : a.department ? (
                    <span className="flex items-center gap-2">
                      <Badge tone="brand">Dept</Badge>
                      {a.department.code}
                    </span>
                  ) : a.kind ? (
                    <span className="flex items-center gap-2">
                      <Badge tone="brand">
                        {({ DIRECTOR: "All Directors", VOLUNTEER: "All Volunteers" } as const)[a.kind] ?? "Unknown"}
                      </Badge>
                    </span>
                  ) : (
                    <span className="text-subtle-foreground">Unknown</span>
                  )}
                </TD>
                <TD>
                  {a.term ? (
                    <span className="font-mono text-xs">{a.term.code}</span>
                  ) : (
                    <span className="text-subtle-foreground">Global</span>
                  )}
                </TD>
                <TD>
                  <form action={deleteAssignmentAction}>
                    <input type="hidden" name="assignmentId" value={a.id} />
                    <ConfirmButton label="Remove" confirmLabel="Remove assignment? Confirm?" />
                  </form>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}

      {/* Create person assignment */}
      <Card className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground-soft">Assign role to person</h3>

        {/* Person search box */}
        <form method="GET" className="flex items-end gap-3">
          <Field label="Search people">
            <Input
              type="search"
              name="assignq"
              defaultValue={assignq ?? ""}
              placeholder="Name or netID..."
              className="w-64"
            />
          </Field>
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
          {assignq && (
            <a
              href={pageHref}
              className="self-end pb-2 text-sm text-muted-foreground hover:text-foreground"
            >
              Clear
            </a>
          )}
        </form>

        {/* Person search results */}
        {assignq && assignq.trim() && (
          <div className="rounded-2xl border border-border">
            <div className="border-b border-border-subtle px-4 py-3">
              <p className="text-sm font-medium text-foreground-soft">
                {personResults.length === 0
                  ? `No results for "${assignq}"`
                  : `${personResults.length} result(s) for "${assignq}"`}
              </p>
            </div>
            {personResults.length > 0 && (
              <div className="divide-y divide-border-subtle">
                {personResults.map((person) => (
                  <div
                    key={person.id}
                    className="flex flex-wrap items-center gap-3 px-4 py-3"
                  >
                    <div className="min-w-[12rem]">
                      <p className="text-sm font-medium text-foreground">{person.name}</p>
                      {person.netId && (
                        <p className="text-xs text-subtle-foreground">{person.netId}</p>
                      )}
                    </div>
                    <form action={assignPersonAction} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="personId" value={person.id} />
                      <Field label="Role">
                        <Select name="roleId" className="w-44">
                          {roles.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Term">
                        <TermSelect terms={terms} />
                      </Field>
                      <Button type="submit" variant="primary" size="sm" className="self-end">
                        Assign
                      </Button>
                    </form>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Create department assignment */}
      <Card className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground-soft">Assign role to department</h3>
        <form action={assignDepartmentAction} className="flex flex-wrap items-end gap-3">
          <Field label="Department">
            <Select name="departmentId" className="w-56">
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} -- {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Role">
            <Select name="roleId" className="w-44">
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Term">
            <TermSelect terms={terms} />
          </Field>
          <Button type="submit" variant="primary" size="sm">
            Assign department
          </Button>
        </form>
      </Card>

      {/* Create kind (cohort) assignment */}
      <Card className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground-soft">Assign role to all members of a kind</h3>
        <p className="text-sm text-subtle-foreground">
          Applies to every active member of the chosen kind in the selected term (or every term, if Global), including members added later.
        </p>
        <form action={assignKindAction} className="flex flex-wrap items-end gap-3">
          <Field label="Members">
            <Select name="kind" className="w-44">
              <option value="VOLUNTEER">All Volunteers</option>
              <option value="DIRECTOR">All Directors</option>
            </Select>
          </Field>
          <Field label="Role">
            <Select name="roleId" className="w-44">
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Term">
            <TermSelect terms={terms} defaultValue={activeTermId} />
          </Field>
          <Button type="submit" variant="primary" size="sm">
            Assign cohort
          </Button>
        </form>
      </Card>
    </section>
  );
}
