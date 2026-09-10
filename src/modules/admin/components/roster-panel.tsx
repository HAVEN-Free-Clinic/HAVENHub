/**
 * RosterPanel: server component for managing a term's roster.
 *
 * Features:
 *  - Per-department cards (all active departments shown, even empty ones)
 *  - Each member shown as a chip with name, kind badge, and a remove ConfirmButton
 *  - Add-member search (GET-based, ?addq=) with person search results, dept+kind
 *    selects, and an Add button per row -- no client JS required
 *  - Copy-roster section (PLANNING terms only): source term select, kind checkboxes,
 *    ConfirmButton; success redirects with ?copied=N&skipped=M
 *
 * NOTE: Recruitment-driven FA26 roster intake is deferred to the Recruitment module.
 * NOTE: Person merge tooling for duplicate roster entries is deferred; resolve in Airtable.
 */

import type { ReactNode } from "react";
import type { Person, Term } from "@prisma/client";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { termRoster, addMembership, removeMembership, copyRosterFromTerm, membershipHasDirectorShifts, MembershipForeignKeyError, MembershipNotFoundError, RosterCopyError } from "@/modules/admin/services/roster";
import { searchPeople } from "@/modules/admin/services/people";
import { listTerms, TermNotFoundError } from "@/modules/admin/services/terms";
import { LastAdminError } from "@/platform/rbac/last-admin";
import { MembershipKindBadge } from "@/platform/ui/membership-kind-badge";
import { Button } from "@/platform/ui/button";
import { PersonSearchPanel } from "./person-search-panel";
import { Card } from "@/platform/ui/card";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox, CheckboxGroup } from "@/platform/ui/checkbox";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { SectionHeader } from "@/platform/ui/section-header";
import { EmptyState } from "@/platform/ui/empty-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RosterPanelProps = {
  term: Term;
  /** Search query from ?addq= URL param. */
  addq?: string;
  /** Redirect base URL (without query params) for actions. */
  termDetailHref: string;
  /** When false, the add/remove/copy editing controls are hidden (view-only). The
   *  page admits admin.manage_terms OR admin.manage_roster, but the roster mutations
   *  require admin.manage_roster; without this a manage_terms-only admin sees forms
   *  that dead-end at /no-access. Mirrors PersonMembershipsPanel. */
  canManage: boolean;
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MemberChip({
  person,
  membershipId,
  kind,
  removeAction,
  canManage,
}: {
  person: Person;
  membershipId: string;
  kind: "DIRECTOR" | "VOLUNTEER";
  removeAction: (formData: FormData) => Promise<void>;
  canManage: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5">
      <span className="text-sm font-medium text-foreground">{person.name}</span>
      <MembershipKindBadge kind={kind} />
      {canManage && (
        <form action={removeAction} className="ml-auto">
          <input type="hidden" name="membershipId" value={membershipId} />
          <ConfirmButton label="Remove" confirmLabel="Remove member?" />
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export async function RosterPanel({
  term,
  addq,
  termDetailHref,
  canManage,
}: RosterPanelProps): Promise<ReactNode> {
  // Fetch roster groups and all active departments in parallel.
  const [rosterGroups, allActiveDepts, allMembershipsWithIds] = await Promise.all([
    termRoster(term.id),
    prisma.department.findMany({
      where: { isActive: true },
      orderBy: { code: "asc" },
    }),
    // We need the membership IDs for remove buttons; termRoster only returns Person[].
    prisma.termMembership.findMany({
      where: { termId: term.id, status: "ACTIVE" },
      select: { id: true, personId: true, departmentId: true, kind: true },
    }),
  ]);

  // Build a lookup: deptId -> roster group
  const rosterByDept = new Map(rosterGroups.map((g) => [g.department.id, g]));

  // Cards to render: every active department PLUS any INACTIVE department that
  // still has active members this term. Otherwise deactivating a department hides
  // its remaining members from the roster with no way to remove/move them here.
  const activeIds = new Set(allActiveDepts.map((d) => d.id));
  const displayDepts = [
    ...allActiveDepts.map((d) => ({ id: d.id, code: d.code, name: d.name, isActive: true })),
    ...rosterGroups
      .map((g) => g.department)
      .filter((d) => !activeIds.has(d.id))
      .map((d) => ({ id: d.id, code: d.code, name: d.name, isActive: false })),
  ].sort((a, b) => a.code.localeCompare(b.code));

  // Build membership id lookup: "${personId}:${deptId}:${kind}" -> membershipId
  const membershipIdMap = new Map<string, string>();
  for (const m of allMembershipsWithIds) {
    membershipIdMap.set(`${m.personId}:${m.departmentId}:${m.kind}`, m.id);
  }

  // ---------------------------------------------------------------------------
  // Search results for add-member flow
  // ---------------------------------------------------------------------------

  let searchResults: Person[] = [];
  if (addq && addq.trim()) {
    const result = await searchPeople({
      search: addq.trim(),
      status: "ACTIVE",
      pageSize: 10,
    });
    searchResults = result.rows;
  }

  // ---------------------------------------------------------------------------
  // Copy-roster source terms (PLANNING terms only)
  // ---------------------------------------------------------------------------

  let sourceTerms: (Term & { _count: { memberships: number } })[] = [];
  if (term.status === "PLANNING") {
    const allTerms = await listTerms();
    sourceTerms = allTerms.filter((t) => t.id !== term.id);
  }

  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------

  async function removeAction(formData: FormData) {
    "use server";
    const actorSession = await requirePermission("admin.manage_roster");
    const membershipId = formData.get("membershipId") as string | null;
    if (!membershipId) {
      redirect(`${termDetailHref}?rosterError=${encodeURIComponent("Missing membership ID.")}`);
    }
    if (await membershipHasDirectorShifts(membershipId)) {
      redirect(
        `${termDetailHref}?rosterError=${encodeURIComponent("This member has director shift assignments this term. Remove or reassign those shifts before removing their director role.")}`
      );
    }
    try {
      await removeMembership(actorSession.personId, membershipId);
    } catch (err) {
      if (err instanceof LastAdminError) {
        redirect(`${termDetailHref}?rosterError=${encodeURIComponent(err.message)}`);
      }
      if (err instanceof MembershipNotFoundError) {
        redirect(
          `${termDetailHref}?rosterError=${encodeURIComponent("Member no longer exists; the page may be stale.")}`
        );
      }
      redirect(`${termDetailHref}?rosterError=${encodeURIComponent("Failed to remove member.")}`);
    }
    redirect(`${termDetailHref}?saved=1`);
  }

  async function addAction(formData: FormData) {
    "use server";
    const actorSession = await requirePermission("admin.manage_roster");
    const personId = formData.get("personId") as string | null;
    const departmentId = formData.get("departmentId") as string | null;
    const kindRaw = formData.get("kind");
    const kind = kindRaw === "DIRECTOR" || kindRaw === "VOLUNTEER" ? kindRaw : null;

    if (!personId || !departmentId || !kind) {
      redirect(
        `${termDetailHref}?rosterError=${encodeURIComponent("All fields are required.")}`
      );
    }

    try {
      await addMembership(actorSession.personId, {
        personId,
        termId: term.id,
        departmentId,
        kind,
      });
    } catch (err) {
      if (err instanceof MembershipForeignKeyError) {
        redirect(
          `${termDetailHref}?rosterError=${encodeURIComponent(`Invalid reference: ${err.field}`)}`
        );
      }
      redirect(
        `${termDetailHref}?rosterError=${encodeURIComponent("Failed to add member.")}`
      );
    }
    // Success: redirect WITHOUT addq to clear search, with saved=1
    redirect(`${termDetailHref}?saved=1`);
  }

  async function copyRosterAction(formData: FormData) {
    "use server";
    const actorSession = await requirePermission("admin.manage_roster");
    const fromTermId = formData.get("fromTermId") as string | null;
    const kindsRaw = formData.getAll("kinds") as string[];
    const allDepartments = formData.get("allDepartments") === "on";
    const departmentIdsRaw = formData.getAll("departmentIds") as string[];

    if (!fromTermId) {
      redirect(
        `${termDetailHref}?rosterError=${encodeURIComponent("Please select a source term.")}`
      );
    }

    const kinds = kindsRaw.filter((k): k is "DIRECTOR" | "VOLUNTEER" =>
      k === "DIRECTOR" || k === "VOLUNTEER"
    );

    if (kinds.length === 0) {
      redirect(
        `${termDetailHref}?rosterError=${encodeURIComponent("Select at least one membership kind to copy.")}`
      );
    }

    // Resolve department filter: undefined means all, array means specific selection
    const departmentIds: string[] | undefined = allDepartments ? undefined : departmentIdsRaw;

    if (!allDepartments && departmentIdsRaw.length === 0) {
      redirect(
        `${termDetailHref}?rosterError=${encodeURIComponent("Select at least one department (or check All departments).")}`
      );
    }

    let result: { copied: number; skipped: number };
    try {
      result = await copyRosterFromTerm(actorSession.personId, fromTermId, term.id, kinds, departmentIds);
    } catch (err) {
      if (err instanceof RosterCopyError || err instanceof TermNotFoundError) {
        redirect(
          `${termDetailHref}?rosterError=${encodeURIComponent(err.message)}`
        );
      }
      redirect(
        `${termDetailHref}?rosterError=${encodeURIComponent("Failed to copy roster.")}`
      );
    }

    redirect(`${termDetailHref}?copied=${result.copied}&skipped=${result.skipped}`);
  }

  return (
    <section className="space-y-8">
      <SectionHeader className="mb-4">Roster</SectionHeader>

      {/* Add-member search + results: editing controls, admin.manage_roster only. */}
      {canManage && (
      <>
      <PersonSearchPanel
        paramName="addq"
        label="Search people to add"
        query={addq ?? undefined}
        clearHref={termDetailHref}
        results={searchResults}
        resultsHint="select department and role, then Add"
        renderRowForm={(person) => (
          <form action={addAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="personId" value={person.id} />
            <Field label="Department">
              <Select name="departmentId" className="w-48">
                {allActiveDepts.map((dept) => (
                  <option key={dept.id} value={dept.id}>
                    {dept.code} · {dept.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Role">
              <Select name="kind" className="w-36">
                <option value="VOLUNTEER">Volunteer</option>
                <option value="DIRECTOR">Director</option>
              </Select>
            </Field>
            <Button type="submit" variant="primary" size="sm" className="self-end">
              Add
            </Button>
          </form>
        )}
      />
      </>
      )}

      {/* Department cards */}
      <div className="space-y-6">
        {displayDepts.map((dept) => {
          const group = rosterByDept.get(dept.id);
          const directors = group?.directors ?? [];
          const volunteers = group?.volunteers ?? [];
          const isEmpty = directors.length === 0 && volunteers.length === 0;

          return (
            <div
              key={dept.id}
              className="rounded-2xl border border-border bg-muted p-5"
            >
              <SectionHeader level="card" as="h3" className="mb-4">
                {dept.code} · {dept.name}
                {!dept.isActive && <span className="ml-2 text-xs font-normal text-subtle-foreground">(inactive: remaining members)</span>}
              </SectionHeader>

              {isEmpty ? (
                <EmptyState inline>No members yet.</EmptyState>
              ) : (
                <div className="space-y-4">
                  {/* Directors list */}
                  {directors.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Directors</p>
                      <div className="space-y-1.5">
                        {directors.map((person) => {
                          const membershipId = membershipIdMap.get(
                            `${person.id}:${dept.id}:DIRECTOR`
                          );
                          if (!membershipId) return null;
                          return (
                            <MemberChip
                              key={person.id}
                              person={person}
                              membershipId={membershipId}
                              kind="DIRECTOR"
                              removeAction={removeAction}
                              canManage={canManage}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Volunteers list */}
                  {volunteers.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Volunteers</p>
                      <div className="space-y-1.5">
                        {volunteers.map((person) => {
                          const membershipId = membershipIdMap.get(
                            `${person.id}:${dept.id}:VOLUNTEER`
                          );
                          if (!membershipId) return null;
                          return (
                            <MemberChip
                              key={person.id}
                              person={person}
                              membershipId={membershipId}
                              kind="VOLUNTEER"
                              removeAction={removeAction}
                              canManage={canManage}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Copy-roster section: PLANNING terms only, admin.manage_roster only */}
      {canManage && term.status === "PLANNING" && (
        <Card>
          <SectionHeader level="card" as="h3" className="mb-4">Copy roster from another term</SectionHeader>
          {sourceTerms.length === 0 ? (
            <EmptyState inline>No other terms available to copy from.</EmptyState>
          ) : (
            <form action={copyRosterAction} className="space-y-4">
              <div className="flex flex-wrap gap-6">
                <Field label="Source term">
                  <Select name="fromTermId" className="w-56">
                    {sourceTerms.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.code} · {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {/* The <p> here named the pair on screen and to nobody else. */}
                <CheckboxGroup legend="Kinds to copy">
                  <div className="flex gap-4">
                    <Checkbox name="kinds" value="DIRECTOR" defaultChecked label="Directors" />
                    <Checkbox name="kinds" value="VOLUNTEER" defaultChecked label="Volunteers" />
                  </div>
                </CheckboxGroup>
              </div>

              {/* Departments. This block hand-rolled the exact fieldset/legend
                  recipe CheckboxGroup now owns, class for class. */}
              <CheckboxGroup legend="Departments">
                <Checkbox name="allDepartments" label="All departments" />
                <div className="grid grid-cols-3 gap-x-4 gap-y-1 sm:grid-cols-4">
                  {allActiveDepts.map((dept) => (
                    <Checkbox key={dept.id} name="departmentIds" value={dept.id} label={dept.code} />
                  ))}
                </div>
                <p className="text-xs text-subtle-foreground">Check All departments, or pick specific ones.</p>
              </CheckboxGroup>

              <ConfirmButton label="Copy roster" confirmLabel="Copy the roster from the selected term?" />
            </form>
          )}
        </Card>
      )}
    </section>
  );
}
