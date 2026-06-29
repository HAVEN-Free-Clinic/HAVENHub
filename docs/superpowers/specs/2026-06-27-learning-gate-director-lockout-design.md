# Fix #65 — Director learning-gate lockout

**Issue:** [#65](https://github.com/HAVEN-Free-Clinic/HAVENHub/issues/65) — Members without `learning.access` (e.g. directors) can be required by the onboarding gate to finish a course they are forbidden to open.

**Audit key:** `learning/director-no-learning-access-gate-lockout` · Severity: High · Area: learning

## Problem

"Who is assigned a course" and "who can open a course" are computed from different inputs:

- **Assigned** (`coursesForMember` via `assignedCourseIds` in `src/modules/learning/services/enrollment.ts`): any ACTIVE `TermMembership` in an assigned department (or any `assignToAll` course). No filter on membership kind, no permission check.
- **Can open** (`/learning/[courseId]` → `requireModuleAccess("learning")` → `requirePermission("learning.access")`, plus `persistScoCmi`): requires the `learning.access` permission.

The auto-attached **Director** system role (granted from a `DIRECTOR`-kind membership in `src/platform/rbac/engine.ts`) does **not** grant `learning.access` — only **Volunteer** does (`prisma/seed.ts`). So a member whose active memberships are all `DIRECTOR`-kind:

1. is assigned any course targeting their department or any `assignToAll` course,
2. `getMyCourses` returns it, so `deriveLearningTaskState` marks the gate task INCOMPLETE,
3. opening `/learning/[courseId]` runs `requirePersonSession` → `enforceOnboarding` first, which redirects the not-onboarded director to `/get-started`.

Result: the director bounces `/get-started` ↔ `/learning` and can **never** clear the requirement — permanently locked out of the entire app. Triggers as soon as any course is assigned to a department with directors, or any `assignToAll` course exists.

The same mismatch also exists in the completion dashboard (`getCourseCompletion` in `src/modules/learning/services/dashboard.ts`), which lists every active department member regardless of `learning.access`, so directors show as perpetually NOT_STARTED there too.

## Decision

**Grant directors `learning.access`** (the issue's first recommendation). Directors can open and are required to complete assigned department / org-wide courses — appropriate for org-wide (`assignToAll`) compliance courses, and it keeps directors' separate director-training track intact.

Because any person with an active membership auto-gets either the Director or Volunteer role, and Volunteer already has `learning.access`, granting it to **Director** unifies assignment and access for **every** gated member. All four consumers (onboarding gate, play route, completion dashboard, My Courses) become consistent with **no change to enrollment/gate/dashboard logic**.

### Alternatives considered

- **Exclude non-`learning.access` members from assignment** — robust structurally, but would silently skip directors on org-wide compliance courses.
- **Gate-only tolerance** (treat un-openable courses as NOT_REQUIRED) — leaves the assignment/access mismatch in place (directors still listed assigned-but-incomplete on the dashboard and shown un-openable courses on My Courses / get-started).

## Changes

1. **Extract system-role definitions** from `prisma/seed.ts` into a new side-effect-free module `src/platform/rbac/system-roles.ts` exporting `SYSTEM_ROLES` (`{ name, description, grants }[]`). `seed.ts` imports it instead of defining the list inline. Rationale: `seed.ts` runs `main()` on import, so its role list cannot be imported by a test; extracting makes the canonical grant lists a single, importable, testable source of truth.

2. **Add `learning.access`** to the Director entry's grants:
   `schedule.view, schedule.edit_own_dept, volunteers.view, my-info.access, learning.access`.

3. **New Prisma data migration** `prisma/migrations/<ts>_grant_director_learning_access/migration.sql` to backfill the grant onto the existing production Director role (the Vercel build runs `prisma migrate deploy`; the seed does not run in prod). Idempotent:

   ```sql
   INSERT INTO "RoleGrant" ("id", "roleId", "permission")
   SELECT gen_random_uuid()::text, r."id", 'learning.access'
   FROM "Role" r
   WHERE r."name" = 'Director' AND r."isSystem" = true
   ON CONFLICT ("roleId", "permission") DO NOTHING;
   ```

   Safe if the Director role does not exist yet (no-op); idempotent against the `RoleGrant_roleId_permission_key` unique index.

## Tests (TDD)

- **Unit:** the shared `SYSTEM_ROLES` Director entry includes `learning.access` (regression lock referencing #65; fails if anyone removes the grant later).
- **Integration (RBAC):** a director-only ACTIVE member, given the Director system role built from the shared definition, resolves `can(person, "learning.access") === true` — proving the auto-role path end-to-end. Mirrors `src/platform/rbac/engine.test.ts`.

## Out of scope (noted)

The learning sub-nav (`ModuleNav` in `src/app/(app)/learning/layout.tsx`) renders "Manage courses" / "Completion" tabs to anyone with `learning.access`, even without `learning.manage_courses` / `learning.view_progress` — those pages redirect on click. This already affects volunteers identically and is not part of #65.
