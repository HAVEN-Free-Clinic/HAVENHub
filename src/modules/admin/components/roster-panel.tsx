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
import { termRoster, addMembership, removeMembership, copyRosterFromTerm, MembershipForeignKeyError, MembershipNotFoundError, RosterCopyError } from "@/modules/admin/services/roster";
import { searchPeople } from "@/modules/admin/services/people";
import { listTerms, TermNotFoundError } from "@/modules/admin/services/terms";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Input, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { ConfirmButton } from "@/platform/ui/confirm-button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RosterPanelProps = {
  term: Term;
  /** Search query from ?addq= URL param. */
  addq?: string;
  /** Redirect base URL (without query params) for actions. */
  termDetailHref: string;
  /** Pre-fetched roster copy counts from ?copied= and ?skipped= params. */
  copiedCount?: number;
  skippedCount?: number;
  /** Error string from ?rosterError= redirect. */
  rosterError?: string;
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h2>
  );
}

function MemberChip({
  person,
  membershipId,
  kind,
  removeAction,
}: {
  person: Person;
  membershipId: string;
  kind: "DIRECTOR" | "VOLUNTEER";
  removeAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5">
      <span className="text-sm font-medium text-foreground">{person.name}</span>
      {kind === "DIRECTOR" ? (
        <Badge tone="brand">Director</Badge>
      ) : (
        <Badge tone="default">Volunteer</Badge>
      )}
      <form action={removeAction} className="ml-auto">
        <input type="hidden" name="membershipId" value={membershipId} />
        <ConfirmButton label="Remove" confirmLabel="Remove member?" />
      </form>
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
  copiedCount,
  skippedCount,
  rosterError,
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
    const actorSession = await requirePermission("admin.manage_terms");
    const membershipId = formData.get("membershipId") as string | null;
    if (!membershipId) {
      redirect(`${termDetailHref}?rosterError=${encodeURIComponent("Missing membership ID.")}`);
    }
    try {
      await removeMembership(actorSession.personId, membershipId);
    } catch (err) {
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
    const actorSession = await requirePermission("admin.manage_terms");
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
    const actorSession = await requirePermission("admin.manage_terms");
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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <section className="space-y-8">
      <SectionHeading>Roster</SectionHeading>

      {/* Error and status messages */}
      {rosterError && <Alert tone="error">{rosterError}</Alert>}
      {copiedCount !== undefined && skippedCount !== undefined && (
        <Alert tone="success">
          Copied {copiedCount} membership(s); {skippedCount} already existed and were skipped.
        </Alert>
      )}

      {/* Add-member search box (global, above cards) */}
      <form method="GET" className="flex items-end gap-3">
        {/* No other params are preserved; this form resets all query state. */}
        <Field label="Search people to add">
          <Input
            type="search"
            name="addq"
            defaultValue={addq ?? ""}
            placeholder="Name or netID..."
            className="w-72"
          />
        </Field>
        <Button type="submit" variant="outline" size="sm">
          Search
        </Button>
        {addq && (
          <a
            href={termDetailHref}
            className="text-sm text-muted-foreground hover:text-foreground self-end pb-2"
          >
            Clear
          </a>
        )}
      </form>

      {/* Search results panel */}
      {addq && addq.trim() && (
        <div className="rounded-2xl border border-border bg-surface">
          <div className="border-b border-border-subtle px-4 py-3">
            <p className="text-sm font-medium text-foreground-soft">
              {searchResults.length === 0
                ? `No results for "${addq}"`
                : `${searchResults.length} result(s) for "${addq}" -- select department and role, then Add`}
            </p>
          </div>
          {searchResults.length > 0 && (
            <div className="divide-y divide-border-subtle">
              {searchResults.map((person) => (
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
                  <form action={addAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="personId" value={person.id} />
                    <Field label="Department">
                      <Select name="departmentId" className="w-48">
                        {allActiveDepts.map((dept) => (
                          <option key={dept.id} value={dept.id}>
                            {dept.code} -- {dept.name}
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
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Department cards */}
      <div className="space-y-6">
        {allActiveDepts.map((dept) => {
          const group = rosterByDept.get(dept.id);
          const directors = group?.directors ?? [];
          const volunteers = group?.volunteers ?? [];
          const isEmpty = directors.length === 0 && volunteers.length === 0;

          return (
            <div
              key={dept.id}
              className="rounded-2xl border border-border bg-muted p-5"
            >
              <h3 className="mb-4 text-sm font-semibold text-foreground-soft">
                {dept.code} -- {dept.name}
              </h3>

              {isEmpty ? (
                <p className="text-sm text-subtle-foreground">No members yet.</p>
              ) : (
                <div className="space-y-4">
                  {/* Directors list */}
                  {directors.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Directors
                      </p>
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
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Volunteers list */}
                  {volunteers.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Volunteers
                      </p>
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

      {/* Copy-roster section: PLANNING terms only */}
      {term.status === "PLANNING" && (
        <Card>
          <h3 className="mb-4 text-sm font-semibold text-foreground-soft">Copy roster from another term</h3>
          {sourceTerms.length === 0 ? (
            <p className="text-sm text-muted-foreground">No other terms available to copy from.</p>
          ) : (
            <form action={copyRosterAction} className="space-y-4">
              <div className="flex flex-wrap gap-6">
                <Field label="Source term">
                  <Select name="fromTermId" className="w-56">
                    {sourceTerms.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.code} -- {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-medium text-muted-foreground">Kinds to copy</p>
                  <div className="flex gap-4 pt-1">
                    <label className="flex items-center gap-2 text-sm text-foreground-soft">
                      <Checkbox name="kinds" value="DIRECTOR" defaultChecked />
                      Directors
                    </label>
                    <label className="flex items-center gap-2 text-sm text-foreground-soft">
                      <Checkbox name="kinds" value="VOLUNTEER" defaultChecked />
                      Volunteers
                    </label>
                  </div>
                </div>
              </div>

              {/* Departments fieldset */}
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-muted-foreground">Departments</legend>
                <label className="flex items-center gap-2 text-sm text-foreground-soft">
                  <Checkbox name="allDepartments" />
                  All departments
                </label>
                <div className="grid grid-cols-3 gap-x-4 gap-y-1 sm:grid-cols-4">
                  {allActiveDepts.map((dept) => (
                    <label key={dept.id} className="flex items-center gap-1.5 text-sm text-foreground-soft">
                      <Checkbox name="departmentIds" value={dept.id} />
                      {dept.code}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-subtle-foreground">Check All departments, or pick specific ones.</p>
              </fieldset>

              <ConfirmButton label="Copy roster" confirmLabel="Copy roster from selected term? Confirm?" />
            </form>
          )}
        </Card>
      )}
    </section>
  );
}
