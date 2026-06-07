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
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
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
    <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
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
    <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5">
      <span className="text-sm font-medium text-slate-800">{person.name}</span>
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

    let result: { copied: number; skipped: number };
    try {
      result = await copyRosterFromTerm(actorSession.personId, fromTermId, term.id, kinds);
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
      {rosterError && (
        <p
          role="alert"
          className="rounded-md border border-critical/20 bg-red-50 px-3 py-2 text-sm text-critical"
        >
          {rosterError}
        </p>
      )}
      {copiedCount !== undefined && skippedCount !== undefined && (
        <p className="text-sm text-success">
          Copied {copiedCount} membership(s); {skippedCount} already existed and were skipped.
        </p>
      )}

      {/* Add-member search box (global, above cards) */}
      <form method="GET" className="flex items-end gap-3">
        {/* No other params are preserved; this form resets all query state. */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">
            Search people to add
          </label>
          <Input
            type="search"
            name="addq"
            defaultValue={addq ?? ""}
            placeholder="Name or netID..."
            className="w-72"
          />
        </div>
        <Button type="submit" variant="outline" size="sm">
          Search
        </Button>
        {addq && (
          <a
            href={termDetailHref}
            className="text-sm text-slate-500 hover:text-slate-900 self-end pb-2"
          >
            Clear
          </a>
        )}
      </form>

      {/* Search results panel */}
      {addq && addq.trim() && (
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-medium text-slate-700">
              {searchResults.length === 0
                ? `No results for "${addq}"`
                : `${searchResults.length} result(s) for "${addq}" -- select department and role, then Add`}
            </p>
          </div>
          {searchResults.length > 0 && (
            <div className="divide-y divide-slate-100">
              {searchResults.map((person) => (
                <div
                  key={person.id}
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                >
                  <div className="min-w-[12rem]">
                    <p className="text-sm font-medium text-slate-800">{person.name}</p>
                    {person.netId && (
                      <p className="text-xs text-slate-400">{person.netId}</p>
                    )}
                  </div>
                  <form action={addAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="personId" value={person.id} />
                    <div className="flex flex-col gap-1">
                      <label className="text-xs font-medium text-slate-500">Department</label>
                      <Select name="departmentId" className="w-48">
                        {allActiveDepts.map((dept) => (
                          <option key={dept.id} value={dept.id}>
                            {dept.code} -- {dept.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs font-medium text-slate-500">Role</label>
                      <Select name="kind" className="w-36">
                        <option value="VOLUNTEER">Volunteer</option>
                        <option value="DIRECTOR">Director</option>
                      </Select>
                    </div>
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
              className="rounded-lg border border-slate-200 bg-slate-50 p-5"
            >
              <h3 className="mb-4 text-sm font-semibold text-slate-700">
                {dept.code} -- {dept.name}
              </h3>

              {isEmpty ? (
                <p className="text-sm text-slate-400">No members yet.</p>
              ) : (
                <div className="space-y-4">
                  {/* Directors list */}
                  {directors.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-400">
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
                      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-400">
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
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="mb-4 text-sm font-semibold text-slate-700">Copy roster from another term</h3>
          {sourceTerms.length === 0 ? (
            <p className="text-sm text-slate-400">No other terms available to copy from.</p>
          ) : (
            <form action={copyRosterAction} className="space-y-4">
              <div className="flex flex-wrap gap-6">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-slate-500">Source term</label>
                  <Select name="fromTermId" className="w-56">
                    {sourceTerms.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.code} -- {t.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-medium text-slate-500">Kinds to copy</p>
                  <div className="flex gap-4 pt-1">
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        name="kinds"
                        value="DIRECTOR"
                        defaultChecked
                        className="rounded border-slate-300"
                      />
                      Directors
                    </label>
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        name="kinds"
                        value="VOLUNTEER"
                        defaultChecked
                        className="rounded border-slate-300"
                      />
                      Volunteers
                    </label>
                  </div>
                </div>
              </div>
              <ConfirmButton label="Copy roster" confirmLabel="Copy roster from selected term? Confirm?" />
            </form>
          )}
        </div>
      )}
    </section>
  );
}
