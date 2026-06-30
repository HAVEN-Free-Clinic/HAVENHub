# RBAC / membership-kind decouple + manual assignment editor

- **Date:** 2026-06-29
- **Status:** Approved design, ready for implementation plan
- **Related:** `2026-06-28-enforce-schedule-permissions-design.md` (issue #82, dropped the stale `schedule.edit_own_dept` director grant), `2026-06-27-learning-gate-director-lockout-design.md` (onboarding gate depends on `learning.access`)

## Problem

Two related gaps in how a person's term assignment and director/volunteer status are managed:

1. **No first-class manual assignment editing outside recruitment.** Today the only non-recruitment path to change a roster is the `RosterPanel` on `/admin/terms/[id]`, gated by the broad `admin.manage_terms` bundle. It is term-centric (not person-centric), offers only add and remove (no in-place role change), and is not delegatable as its own permission. The person detail page (`/admin/people/[id]`) shows memberships read-only.

2. **A hidden second permission system.** `TermMembership.kind` (DIRECTOR / VOLUNTEER) drives access in ways that are invisible to and unmanageable from the roles page (`/admin/roles`). The roles page is supposed to be the source of truth for what a person can do, but kind-derived access bypasses it.

## Goals

- Make the roles page the single source of truth for kind-derived RBAC access (no behavior change for end users, but every grant becomes visible data an admin can edit).
- Add a person-centric assignment editor (add department, change role, remove) for the active term, behind a new delegatable permission.
- Keep `TermMembership.kind` as scope and scheduling metadata, not as a hidden capability grant.

## Non-goals

- Changing how scope works. `manageableDepartmentIds` / `memberDepartmentIds` stay membership-derived. Scope (which departments) is a legitimately different axis from capability (can I do X), and that separation stays.
- Removing kind from the schedule builder eligibility rule (`builder.ts:179`) or the training-track requirement (`requiredTrainingTracks`). Kind remains scheduling/onboarding metadata.
- Per-person editing of archived or future-term memberships from the person page (future/bulk work stays in the term `RosterPanel`).
- Department-scoped role grants for non-directors (considered and deferred; not needed for this work).

## Background: how access actually works today

The system is already separated along two axes that both happen to correlate with kind:

- **Capability** ("can I do X?") comes from RBAC permissions. Directors currently get only `schedule.view`, `volunteers.view`, `my-info.access`, `learning.access`, all via a hardcoded auto-attach. They do NOT have `schedule.edit_own_dept` (dropped in migration `20260628140000`, issue #82) or `volunteers.manage_compliance` (Compliance-Manager-only).
- **Scope** ("for which departments?") comes from `manageableDepartmentIds` / `memberDepartmentIds` in `src/platform/departments.ts`, derived from DIRECTOR memberships plus one-hop delegation. This is what actually lets a director edit their schedule and see their department's compliance. Page guards are two-layer: a module/permission gate, then a scope check that redirects to `/no-access`.

The ONLY true "kind to RBAC" coupling is the hardcoded auto-attach in `src/platform/rbac/engine.ts`:

```ts
const MEMBERSHIP_KIND_ROLE: Record<MembershipKind, string> = {
  DIRECTOR: "Director",
  VOLUNTEER: "Volunteer",
};
```

Crucially, the engine ALSO already resolves role assignments targeted by kind (`engine.ts:45`):

```ts
...(membershipKinds.length ? [{ kind: { in: membershipKinds } }] : []),
```

and the data model already supports it: `RoleAssignment.kind` is a nullable, indexed column with an XOR constraint over (`personId` | `departmentId` | `kind`), added in migration `20260628150000_role_assignment_kind_target`. No kind-scoped `RoleAssignment` rows have ever been seeded; the field is unused infrastructure.

The existing roster service (`src/modules/admin/services/roster.ts`) provides `addMembership` (upsert, revives REMOVED, audits `roster.add`), `removeMembership` (soft-delete, audits `roster.remove`), and `copyRosterFromTerm` (audits `roster.copy`). It deliberately does not check permissions; pages and server actions gate via `requirePermission`.

## Design

Two phases in one spec. Phase 1 is the foundation; Phase 2 builds the editor on top of it.

### Phase 1: RBAC decouple

Replace the hardcoded kind to role auto-attach with seeded, roles-page-editable `RoleAssignment` rows. Behavior is preserved exactly; the grant simply moves from code into data.

1. **`src/platform/rbac/engine.ts`** Remove the `MEMBERSHIP_KIND_ROLE` constant and the `autoRoleNames` machinery (the `autoRoleNames` derivation, the second `prisma.role.findMany` branch, and the loop that unions auto-role grants). The existing `kind: { in: membershipKinds }` clause in the `RoleAssignment` query keeps kind-derived access working, now sourced from data.

2. **`prisma/seed.ts`** Create two global kind-scoped assignments after the system roles are seeded:
   - `{ role: "Director", kind: "DIRECTOR", termId: null, personId: null, departmentId: null }`
   - `{ role: "Volunteer", kind: "VOLUNTEER", termId: null, personId: null, departmentId: null }`

   The `Director` and `Volunteer` system roles in `src/platform/rbac/system-roles.ts` are unchanged (they remain the grant lists).

3. **Backfill migration** A new SQL migration inserts those two `RoleAssignment` rows in production, idempotently (`INSERT ... ON CONFLICT DO NOTHING` against the `RoleAssignment_unique_grant` index, or a guarded insert keyed on roleId+kind). This is the behavior-preserving cutover: the moment the hardcode is gone, the rows carry baseline access. Required because the build runs `migrate deploy`, not the seed (see [[system-role-grants]] precedent).

4. **Roles page (`/admin/roles`)** Extend `src/modules/admin/components/assignment-form.tsx` and `roles-panel.tsx` so kind-scoped assignments are visible and editable: add a "by membership kind" assignment target (DIRECTOR / VOLUNTEER) alongside the existing person and department targets, and render existing kind-scoped rows in the assignments list so an admin can see "Director role to all DIRECTOR memberships" and remove or repoint it. The DB XOR constraint already guarantees exactly one target type per row.

**Unchanged by Phase 1 (the kind = scope + metadata line):** `manageableDepartmentIds`, `memberDepartmentIds`, the builder DIRECTOR-shift rule (`builder.ts:179`), and `requiredTrainingTracks`.

**Net effect:** no end-user experience changes (a fresh director or volunteer still gets the same baseline, and the onboarding gate still clears via the seeded kind assignment), but every grant that flows from kind is now a row an admin can see and edit. An admin who wants kind to grant nothing can delete the row.

### Phase 2: Manual assignment editor

#### New permission: `admin.manage_roster`

- Registered in `src/platform/modules/registry.ts` in the admin module's `permissions` array (alongside `admin.manage_terms` etc., `registry.ts:90-103`). No new nav item (the editor lives on the existing person page).
- Default holders: Platform Admin (automatic via the `*` wildcard) and Volunteer Operations Manager (that system role already owns offboarding, Epic, and disciplinary; roster management fits its remit).
- Backfill migration adds the `admin.manage_roster` grant to the Volunteer Operations Manager role AND to any existing role that currently holds `admin.manage_terms`, so no current term-admin role silently loses roster ability. Add the same grant to the Volunteer Operations Manager entry in `system-roles.ts` so dev seed and prod stay in sync.

#### `changeMembershipKind` service (new, in `roster.ts`)

```
changeMembershipKind(actorPersonId, { membershipId, toKind }):
  1. load membership; not found -> MembershipNotFoundError
  2. if membership.kind === toKind -> no-op (no audit)
  3. if demoting DIRECTOR -> VOLUNTEER:
       count ShiftAssignment rows for { personId, termId, departmentId, role: "DIRECTOR" }
       if any exist -> throw DirectorHasShiftAssignmentsError (typed)
  4. in a transaction:
       upsert target { personId, termId, departmentId, kind: toKind } -> status ACTIVE (revives if a REMOVED row exists, creates otherwise)
       set the old-kind row -> status REMOVED
  5. one audit row: roster.change_kind { before: { kind }, after: { kind: toKind } }
```

Notes:
- The remove-and-recreate is required because `kind` is part of the unique key `@@unique([personId, termId, departmentId, kind])` (a person may hold both a DIRECTOR and a VOLUNTEER row in the same department). It is presented to the user as a single "Change role" action.
- The demotion block is scoped to the membership's own department and term (matching the per-department builder rule). The editor surfaces the typed error as a message instructing the admin to resolve that person's director shift assignments first. No cascade, no silent data loss.

#### Person-page editor (`/admin/people/[id]`)

- The read-only memberships section (`page.tsx:117-167`) becomes an editable client panel modeled on `RosterPanel`, operating on the active term only. Archived and future terms remain read-only history.
- Three operations, all audited, reusing the roster service: Add (department + kind, via `addMembership`), Change role (via `changeMembershipKind`), Remove (via `removeMembership`).
- The page keeps its existing `admin.manage_people` gate for viewing and for the person-edit form. The membership editing controls and their server actions additionally require `admin.manage_roster`; a viewer with `manage_people` but not `manage_roster` sees the memberships read-only as today.

#### Term roster panel re-gate

- The roster mutation server actions on `/admin/terms/[id]` (add, remove, copy) move from `admin.manage_terms` to `admin.manage_roster`. (Implementation note, 2026-06-29: the Change-role action was descoped from the term panel and lives only on the person-page editor, which is the primary surface; the term panel keeps add/remove/copy. Both surfaces block removing a director who still holds director shift assignments this term.)
- The term detail page becomes viewable with `admin.manage_terms` OR `admin.manage_roster` (`page.tsx:32`). Term-CRUD controls and their actions still require `admin.manage_terms`; only the roster panel is active for a `manage_roster`-only holder. Platform Admin holds both via the wildcard.

## Data flow and edge cases

- **Idempotent change-role:** if the target-kind row already exists ACTIVE (person already holds both kinds), step 4 leaves it ACTIVE and removes the old row; the person keeps the target kind. Audit still records the change.
- **Revive on add / change:** `addMembership` and the change transaction both upsert, so a previously REMOVED row is revived rather than colliding with the unique key.
- **Onboarding gate:** unaffected. A fresh member resolves baseline access through the seeded kind-scoped assignment, so `learning.access` / `my-info.access` are present and the gate clears.
- **Audit actions:** `roster.add`, `roster.remove`, `roster.copy` (existing), `roster.change_kind` (new).
- **No accidental access loss:** removing the `MEMBERSHIP_KIND_ROLE` hardcode and the backfill row land in the same deploy; the migration runs before the new code serves traffic.

## Testing strategy

- **Engine:** kind-scoped `RoleAssignment` resolves baseline access for a member of that kind (replaces the deleted auto-attach test); removing the kind row removes baseline; person/department/kind targets all union correctly.
- **Onboarding gate:** a brand-new member of each kind clears the gate with only the seeded kind assignment present.
- **`changeMembershipKind`:** flips kind with a single `roster.change_kind` audit; no-op when already that kind; revives a REMOVED target row; blocks DIRECTOR -> VOLUNTEER when a DIRECTOR shift assignment exists in that department/term (typed error).
- **Permission gating:** `manage_roster` holder can add/change/remove on the person page; a `manage_people`-only viewer sees read-only; term page is reachable by either permission, term-CRUD still requires `manage_terms`.
- **Migration idempotency:** running the Phase 1 and Phase 2 backfills twice is a no-op.

## Migration and rollout

- Ships as a single PR covering both phases. Phases remain logically ordered (decouple first, editor second) for commit hygiene and review, but land together.
- Order within the deploy: schema/grant migrations run via `migrate deploy` before new code serves. The Phase 1 backfill (two kind rows) and the engine change must be in the same deploy. The Phase 2 backfill (the `manage_roster` grants) lands in the same PR/deploy.
- Local/worktree dev must follow the repo's Postgres hazard note ([[local-db-neon-hazard]]): never run `prisma migrate` or vitest against the shared Neon DB; use a throwaway local Postgres with a worktree-local `.env` / `TEST_DATABASE_URL`.

## Risks

- **Custom roles with `manage_terms` but not the new grant** would lose roster ability without the backfill; the Phase 2 backfill explicitly copies `manage_roster` onto any role holding `manage_terms` to prevent this.
- **Deleting a kind-scoped assignment on the roles page** is now a real, powerful action (it can strip baseline access from an entire kind). This is intended (the point is admin control) but should be presented clearly in the roles UI.

## Out of scope / future

- Department-scoped capability grants for non-directors (give someone compliance for one department without a directorship).
- Editing future/archived-term memberships from the person page.
- Cascade handling for director demotion (auto-downgrade or remove dependent shift assignments); current decision is to block and let the admin resolve manually.
