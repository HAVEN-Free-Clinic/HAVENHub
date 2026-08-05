import { cache } from "react";
import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";

type MembershipRow = { departmentId: string; kind: Track };

type AssignmentRow = {
  personId: string | null;
  departmentId: string | null;
  kind: Track | null;
  role: { grants: Array<{ permission: string }> };
};

type AssignmentContext = {
  memberships: MembershipRow[];
  assignments: AssignmentRow[];
};

/**
 * Loads the person's memberships in `termId` and every RoleAssignment that
 * reaches them (directly, through a member department, or through a membership
 * kind), scoped to that term or termId=null. A null `termId` means there is no
 * term to resolve against, so only person-targeted global assignments apply.
 *
 * Shared by getEffectivePermissions (which flattens the grants) and
 * permissionDepartmentIds (which keeps each assignment's target), so the two
 * never disagree about which assignments apply and one render costs one query
 * pair.
 */
const loadAssignmentContext = cache(
  async (personId: string, termId: string | null): Promise<AssignmentContext> => {
    const memberships = termId
      ? await prisma.termMembership.findMany({
          where: { personId, termId, status: "ACTIVE" },
          select: { departmentId: true, kind: true },
        })
      : [];
    const departmentIds = [...new Set(memberships.map((m) => m.departmentId))];
    const membershipKinds = [...new Set(memberships.map((m) => m.kind))];

    const assignments = await prisma.roleAssignment.findMany({
      where: {
        AND: [
          {
            OR: [{ termId: null }, ...(termId ? [{ termId }] : [])],
          },
          {
            OR: [
              { personId },
              ...(departmentIds.length ? [{ departmentId: { in: departmentIds } }] : []),
              ...(membershipKinds.length ? [{ kind: { in: membershipKinds } }] : []),
            ],
          },
        ],
      },
      select: {
        personId: true,
        departmentId: true,
        kind: true,
        role: { select: { grants: { select: { permission: true } } } },
      },
    });

    return { memberships, assignments };
  },
);

/** The active term's id, or null when no term is active. */
async function activeTermId(): Promise<string | null> {
  return (await getActiveTerm())?.id ?? null;
}

/**
 * Union of:
 *  - roles assigned directly to the person (global, or scoped to the active term)
 *  - roles assigned to departments the person actively belongs to in the active term
 *  - roles assigned to the person's active-term membership kinds (DIRECTOR/VOLUNTEER)
 *
 * Baseline Director/Volunteer access is provisioned as kind-target RoleAssignment
 * rows (see prisma/seed.ts and the backfill migration), NOT auto-attached in code,
 * so the roles page is the single source of truth. Computed from live DB state and
 * memoized per request via React cache(): repeated calls in one render hit the DB
 * once, and role changes apply on the next request.
 *
 * This is a flat, department-blind answer to "may they, anywhere?". For a
 * department-scoped question use {@link permissionDepartmentIds}.
 */
export const getEffectivePermissions = cache(
  async (personId: string): Promise<Set<string>> => {
    const { assignments } = await loadAssignmentContext(personId, await activeTermId());

    const permissions = new Set<string>();
    for (const a of assignments) for (const g of a.role.grants) permissions.add(g.permission);
    return permissions;
  },
);

/**
 * The departments where `permission` actually reaches the person, derived from
 * the target of each assignment that grants it:
 *
 *   - person-targeted  -> every department they are an active member of
 *   - department-targeted -> that department alone
 *   - kind-targeted    -> only the departments where their membership is of that kind
 *
 * getEffectivePermissions() collapses every assignment into one global set, which
 * is the right answer for "may they, anywhere?" but the wrong one for a
 * department-scoped ability: a person who directs one department and volunteers
 * in another would carry a Director-assigned permission into the department they
 * merely volunteer in. This keeps the assignment's own scope intact so
 * "own department" means the departments the grant was actually made through.
 *
 * A role granting "*" confers the permission with that assignment's scope, matching
 * hasPermission(). Returns [] when there is no term, the person holds no active
 * membership in it, or no assignment grants the permission.
 *
 * `termId` defaults to the ACTIVE term. Pass an explicit term to ask the question
 * about a non-live term (e.g. a shift request filed against next term).
 */
export const permissionDepartmentIds = cache(
  async (personId: string, permission: string, termId?: string): Promise<string[]> => {
    const { memberships, assignments } = await loadAssignmentContext(
      personId,
      termId ?? (await activeTermId()),
    );
    if (memberships.length === 0) return [];

    const ids = new Set<string>();

    for (const a of assignments) {
      const grantsIt = a.role.grants.some(
        (g) => g.permission === permission || g.permission === "*",
      );
      if (!grantsIt) continue;

      if (a.personId != null) {
        // Person-targeted: unscoped by department, so it reaches all of theirs.
        for (const m of memberships) ids.add(m.departmentId);
      } else if (a.departmentId != null) {
        ids.add(a.departmentId);
      } else if (a.kind != null) {
        for (const m of memberships) if (m.kind === a.kind) ids.add(m.departmentId);
      }
    }

    return [...ids];
  },
);

/** The one place the "*" wildcard rule lives. Use this on any Set from getEffectivePermissions. */
export function hasPermission(perms: Set<string>, permission: string): boolean {
  return perms.has(permission) || perms.has("*");
}

export async function can(personId: string, permission: string): Promise<boolean> {
  return hasPermission(await getEffectivePermissions(personId), permission);
}
