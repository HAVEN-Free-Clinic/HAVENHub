# Plan 3: Admin Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first live module on the hub: Admin, with people management, term lifecycle (the FA26 enabler), the RBAC editor, the audit viewer, and the sync dashboard, all permission-gated and audited.

**Architecture:** Spec §9.4. Pages live at `/admin/*` (thin, in `src/app/admin/`), delegating to `src/modules/admin/` (services + components), which imports only `src/platform/`. The admin manifest flips to `active` and gains nav items; the hub tile becomes a real door. Admin person-edits are the platform's FIRST outbox producers: every mutation that touches mirrored Person fields calls `enqueueMirror` in the same transaction and writes an audit entry.

**Tech Stack:** existing stack only. UI is hand-rolled Tailwind on the established Yale Blue token system; no new dependencies.

**Conventions (binding for every task):** no em-dashes anywhere; the product name in prose is "HAVEN Hub"; all dates render with `timeZone: "UTC"` (clinic dates are noon-UTC anchored); every mutation records an audit entry (`recordAudit`) with before/after; every service mutation validates permissions are NOT its concern (pages/actions gate via `requirePermission`; services trust their caller and stay testable).

**Scope deferred deliberately:** person merge tooling (duplicates get fixed in Airtable and re-imported); module enablement toggles (status stays code-driven in the registry); recruitment-driven FA26 roster intake (Recruitment module). State these in code comments where someone might look for them.

---

## File structure (end state)

```
src/platform/modules/registry.ts        # admin flips to active + nav items
src/platform/ui/                        # new shared primitives
  button.tsx input.tsx select.tsx badge.tsx table.tsx
  pagination.tsx confirm-button.tsx module-nav.tsx page-header.tsx
src/modules/admin/
  services/
    people.ts / people.test.ts          # search, get, create, update, setStatus
    terms.ts / terms.test.ts            # create, activate (swap), archive, clinic dates
    roster.ts / roster.test.ts          # memberships: add, remove, copyFromTerm
    rbac.ts / rbac.test.ts              # roles, grants, assignments
    sync.ts / sync.test.ts              # outbox stats detail, retryFailed, drift list
    audit.ts                            # query-only (no test beyond usage)
  components/                           # client/server components per page
    people-table.tsx person-form.tsx
    term-form.tsx clinic-dates-editor.tsx roster-panel.tsx
    roles-panel.tsx assignment-form.tsx
    audit-table.tsx sync-panel.tsx
src/app/admin/
  layout.tsx                            # requirePermission("admin.access") + AppShell + ModuleNav
  page.tsx                              # overview: counts + quick links
  people/page.tsx people/[id]/page.tsx people/new/page.tsx
  terms/page.tsx terms/[id]/page.tsx terms/new/page.tsx
  roles/page.tsx
  audit/page.tsx
  sync/page.tsx
e2e/admin.spec.ts                       # access control + smoke navigation
```

Server actions live next to their pages (inline `"use server"` functions calling services), mirroring the login page pattern.

---

### Task 0: Branch

- [ ] Already on `plan-3/admin-module` (created from merged main). Commit this plan file: `git add docs/ && git commit -m "docs: plan 3 - admin module"`

---

### Task 1: Module activation, layout, overview, access control

**Files:**
- Modify: `src/platform/modules/registry.ts` (admin entry only)
- Create: `src/platform/ui/module-nav.tsx`, `src/platform/ui/page-header.tsx`, `src/app/admin/layout.tsx`, `src/app/admin/page.tsx`
- Test: extend `e2e/admin.spec.ts` (new file)

- [ ] **Step 1:** Registry: set admin `status: "active"` and:

```ts
    nav: [
      { label: "Overview", href: "/admin" },
      { label: "People", href: "/admin/people" },
      { label: "Terms", href: "/admin/terms" },
      { label: "Roles", href: "/admin/roles" },
      { label: "Audit", href: "/admin/audit" },
      { label: "Sync", href: "/admin/sync" },
    ],
```

The registry test suite still passes untouched (nav is not asserted).

- [ ] **Step 2:** `src/platform/ui/module-nav.tsx` (server component): horizontal tab bar under the page header area. Props `{ items: ModuleNavItem[]; current: string }`. Active item: `border-b-2 border-brand text-brand font-medium`; inactive: `text-slate-500 hover:text-slate-900`. Render as `<nav aria-label="Module">` with `text-sm` links, `gap-6`, bottom border `border-slate-200` across the bar.

- [ ] **Step 3:** `src/platform/ui/page-header.tsx`: `{ title: string; description?: string; action?: ReactNode }` rendering `h1.text-xl.font-semibold.tracking-tight`, optional description `text-sm text-slate-500 mt-1`, action slot right-aligned.

- [ ] **Step 4:** `src/app/admin/layout.tsx`:

```tsx
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { getModule } from "@/platform/modules/registry";
import { AppShell } from "@/platform/ui/app-shell";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const person = await requirePermission("admin.access");
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  const headerList = await headers();
  const path = headerList.get("x-invoke-path") ?? ""; // NOTE: see step note below
  return (
    <AppShell userName={person.name} termLabel={activeTerm?.name ?? null}>
      <ModuleNav items={getModule("admin")!.nav} current={path} />
      <div className="mt-8">{children}</div>
    </AppShell>
  );
}
```

NOTE on `current`: Next.js does not expose the pathname to server layouts reliably. Acceptable approaches: (a) make ModuleNav a client component using `usePathname()` (preferred; mark `"use client"`, drop the `current` prop); (b) highlight nothing. Use (a); adjust Step 2 accordingly (match by `pathname === href` for Overview, `pathname.startsWith(href)` for the rest).

- [ ] **Step 5:** `src/app/admin/page.tsx` (overview): requirePermission already ran in layout. Query counts in parallel (`Promise.all`): people (status ACTIVE), departments (isActive), memberships in active term, roles, audit entries last 7 days, outbox pending+failed. Render a PageHeader ("Admin") and a responsive grid of stat cards (white, `rounded-lg border border-slate-200 p-5`, big number `text-2xl font-semibold`, label `text-xs uppercase tracking-wider text-slate-400`), each linking to its sub-page.

- [ ] **Step 6:** e2e `e2e/admin.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("platform admin reaches the admin overview", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Module" })).toBeVisible();
});

test("a volunteer is bounced from /admin to the hub", async ({ page }) => {
  await devLogin(page, "dev.volunteer@yale.edu");
  await page.goto("/admin");
  await page.waitForURL((url) => url.pathname === "/");
});
```

- [ ] **Step 7:** Hub check: the admin tile now renders as ACTIVE (blue icon chip, links to /admin) for permitted users and is hidden for the volunteer. Gauntlet: `npm test` (89), typecheck, lint, `npm run e2e` (5: 3 existing + 2 new; stop any running dev server first).
- [ ] **Step 8:** Commit: `feat(admin): module live with layout, nav, overview, access control`

---

### Task 2: Shared UI primitives

**Files:** create in `src/platform/ui/`: `button.tsx`, `input.tsx`, `select.tsx`, `badge.tsx`, `table.tsx`, `pagination.tsx`, `confirm-button.tsx`

Specs (all server-compatible except confirm-button):
- **Button** `{ variant?: "primary" | "outline" | "danger" | "ghost"; size?: "sm" | "md" }` plus native button props. primary: `bg-brand text-white hover:bg-brand-hover`; outline: `border border-slate-300 text-slate-700 hover:bg-slate-50`; danger: `bg-critical text-white hover:bg-red-700`; ghost: `text-slate-500 hover:text-slate-900`. Radius `rounded-md`, `text-sm font-medium`, sizes px-4 py-2 / px-3 py-1.5. Focus ring: `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand`.
- **Input/Select**: `rounded-md border border-slate-300 px-3 py-2 text-sm w-full outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15`; label wrapper component `Field { label, children, hint? }` with `text-xs font-medium text-slate-500` labels.
- **Badge** `{ tone?: "default" | "brand" | "success" | "warning" | "critical" }`: pill, `text-[11px] font-medium px-2 py-0.5 rounded-full`, tones map to token tints (e.g. brand: `bg-brand-faint text-brand`).
- **Table**: thin wrappers (`Table`, `THead`, `TR`, `TH`, `TD`) producing `w-full text-sm`, header `text-xs uppercase tracking-wider text-slate-400 text-left`, rows `border-t border-slate-100`, cell padding `px-3 py-2.5`. Container card: `rounded-lg border border-slate-200 bg-white overflow-x-auto`.
- **Pagination** (server-friendly): `{ page, pageCount, hrefFor: (page: number) => string }` rendering Prev/Next links + "Page X of Y".
- **ConfirmButton** (`"use client"`): wraps Button; first click flips to confirm state ("Confirm?" + danger styling) for 3 seconds, second click submits the surrounding form. Used for destructive actions (offboard, remove membership, delete assignment). No window.confirm (blocks automation).

- [ ] Build, typecheck/lint clean, brief visual check on the admin overview (swap its quick-link buttons to Button). Commit: `feat(platform): shared ui primitives`

---

### Task 3: People service (TDD)

**Files:** `src/modules/admin/services/people.ts` + `people.test.ts`

API (all take explicit `actorPersonId` for audit):

```ts
export type PeopleQuery = { search?: string; status?: "ACTIVE" | "OFFBOARDED"; page?: number; pageSize?: number };
export async function searchPeople(q: PeopleQuery): Promise<{ rows: Person[]; total: number; page: number; pageCount: number }>
export async function getPerson(id: string): Promise<(Person & { memberships: (TermMembership & { term: Term; department: Department })[] }) | null>
export type PersonInput = { name: string; netId?: string | null; contactEmail?: string | null; yaleEmail?: string | null; phone?: string | null; epicId?: string | null; yaleAffiliation?: string | null; gradYear?: string | null };
export async function createPerson(actorPersonId: string, input: PersonInput): Promise<Person>
export async function updatePerson(actorPersonId: string, id: string, input: PersonInput): Promise<Person>
export async function setPersonStatus(actorPersonId: string, id: string, status: "ACTIVE" | "OFFBOARDED"): Promise<Person>
```

Behaviors (write the failing tests first; one test per bullet):
- search matches name OR netId OR contactEmail, case-insensitive contains; paginates (default pageSize 25), ordered by name; total/pageCount correct
- createPerson: normalizes netId/emails to lowercase; writes audit `person.create` with after snapshot; enqueues mirror (Outbox row exists with entityType Person, entityId = new id) IN THE SAME TRANSACTION (assert: violate a unique to force a throw inside the tx wrapper in a variant test, confirm no outbox row leaks; simplest: attempt createPerson with a duplicate netId and assert outbox count unchanged)
- updatePerson: audit `person.update` with before/after of CHANGED fields only; enqueues mirror with changedFields listing the changed mirrored field names; no-op update (same values) writes NO audit and NO outbox row
- setPersonStatus to OFFBOARDED: audit `person.offboard`; does NOT enqueue mirror (status is not a mirrored field; the offboard checkbox flow in Airtable belongs to the Volunteers module later; leave a comment)
- unique violations surface as a typed error `PersonConflictError` with a friendly field message (catch P2002), so pages can render it

Mirrored field names constant: reuse the keys of `ALL_PEOPLE_FIELDS` (import from platform) to compute changedFields; only enqueue when at least one mirrored field changed.

- [ ] Red, implement, green; full gauntlet. Commit: `feat(admin): people service with audited, mirrored mutations`

---

### Task 4: People pages

**Files:** `src/app/admin/people/page.tsx`, `src/app/admin/people/[id]/page.tsx`, `src/app/admin/people/new/page.tsx`, `src/modules/admin/components/people-table.tsx`, `person-form.tsx`

- List page: `requirePermission("admin.manage_people")` (page-level; layout already gates admin.access). Search input (GET form, `?q=&status=&page=`), status filter select, table (Name linking to detail, NetID, Email, Status badge, active-term departments), Pagination, "Add person" Button → /admin/people/new. Server component throughout; data via `searchPeople`.
- Detail page: PageHeader (person name, description "NetID jdc239 · linked to Airtable" style), PersonForm (server action → `updatePerson`, redirect back with `?saved=1` toast-line), memberships table (term, department, kind, status), status section: ConfirmButton offboard/reactivate via `setPersonStatus`. Render `PersonConflictError` messages inline (catch in action, redirect with `?error=...`).
- New page: same form → `createPerson`.
- e2e additions (admin.spec.ts): admin searches for "Jack" in /admin/people and sees the linked row; opens detail; sees memberships table. (Read-only e2e; mutation coverage lives in service tests.)

- [ ] Gauntlet incl. e2e (6 total). Commit: `feat(admin): people management pages`

---

### Task 5: Terms service (TDD)

**Files:** `src/modules/admin/services/terms.ts` + `terms.test.ts`

```ts
export function saturdaysBetween(startIso: string, endIso: string): Date[] // noon-UTC anchored, inclusive
export async function listTerms(): Promise<(Term & { _count: { memberships: number } })[]>
export async function createTerm(actorPersonId: string, input: { code: string; name: string; startDate: string; endDate: string }): Promise<Term> // status PLANNING, clinicDates = saturdaysBetween
export async function activateTerm(actorPersonId: string, id: string): Promise<Term> // transactional: archive current ACTIVE (if any), activate target; audit BOTH transitions
export async function archiveTerm(actorPersonId: string, id: string): Promise<Term>
export async function updateClinicDates(actorPersonId: string, id: string, datesIso: string[]): Promise<Term> // replaces the array, noon-UTC normalized, sorted, deduped; audit with before/after counts
```

Test behaviors: saturday generator (18 for SU26 range, all dow=6 UTC, noon anchored); createTerm uppercases code, rejects duplicate code with typed `TermConflictError`; activateTerm swaps atomically (old ACTIVE becomes ARCHIVED; exactly one ACTIVE after; two audit rows `term.archive` + `term.activate`); activate when target is already ACTIVE is a no-op (no audit); archiveTerm; updateClinicDates normalizes (input with duplicate + non-noon timestamps comes out deduped/sorted/noon).

- [ ] Red, implement, green; gauntlet. Commit: `feat(admin): term lifecycle service`

---

### Task 6: Terms pages

**Files:** `src/app/admin/terms/page.tsx`, `terms/[id]/page.tsx`, `terms/new/page.tsx`, components `term-form.tsx`, `clinic-dates-editor.tsx`

- All term pages gate with `requirePermission("admin.manage_terms")`.
- List: table (code, name, dates rendered UTC, status Badge, member count), "Create term" button.
- New: form (code, name, start date, end date) → createTerm → redirect to detail. Inline conflict error.
- Detail: PageHeader (term name + status badge); actions: Activate (ConfirmButton; explains the swap: "Archives {currentActive} and makes {code} the active term"), Archive (ConfirmButton). Clinic dates panel: list of dates (UTC-rendered, weekday asserted), remove buttons per date, add-date input (date picker), "Regenerate Saturdays" button (replaces with saturdaysBetween(start, end)); all through `updateClinicDates`. Roster panel placeholder section ("Roster" heading) wired in Task 8.
- e2e: admin visits /admin/terms, sees SU26 ACTIVE row.

- [ ] Gauntlet. Commit: `feat(admin): term lifecycle pages`

---

### Task 7: Roster service (TDD)

**Files:** `src/modules/admin/services/roster.ts` + `roster.test.ts`

```ts
export async function termRoster(termId: string): Promise<Array<{ department: Department; directors: Person[]; volunteers: Person[] }>> // grouped, ACTIVE memberships only, sorted by dept code
export async function addMembership(actorPersonId: string, input: { personId: string; termId: string; departmentId: string; kind: "DIRECTOR" | "VOLUNTEER" }): Promise<void> // upsert (revives REMOVED); audit roster.add
export async function removeMembership(actorPersonId: string, membershipId: string): Promise<void> // status REMOVED (soft); audit roster.remove
export async function copyRosterFromTerm(actorPersonId: string, fromTermId: string, toTermId: string, kinds: Array<"DIRECTOR" | "VOLUNTEER">): Promise<{ copied: number; skipped: number }> // copies ACTIVE memberships of the chosen kinds; skips people already in the target term for that dept+kind; refuses if target term is ARCHIVED (typed error); audit roster.copy with counts
```

Tests: grouping/sorting; add revives a REMOVED row instead of violating the compound unique; remove soft-deletes; copy copies only chosen kinds, skips existing, refuses archived target, audit row has counts.

- [ ] Red, implement, green; gauntlet. Commit: `feat(admin): roster service`

---

### Task 8: Roster UI

**Files:** `src/modules/admin/components/roster-panel.tsx`, wire into `terms/[id]/page.tsx`

- Per-department cards (dept code heading, member chips with kind badge and a small remove ConfirmButton), an "Add member" row per card (person search select: server-rendered `<select>` is unusable at 660 people; implement a small client combobox: input + datalist built from a lightweight people list endpoint OR a server-filtered search param. Simplest robust: a GET search box scoped to the panel (`?addq=`) listing matches with an Add button per row + kind select. Choose this; no client JS needed.)
- "Copy roster from term" section on PLANNING terms: source term select + kind checkboxes + ConfirmButton; shows resulting copied/skipped counts via redirect query.
- e2e: admin opens SU26 term detail and sees roster cards with at least one department.

- [ ] Gauntlet. Commit: `feat(admin): roster management ui`

---

### Task 9: RBAC service (TDD)

**Files:** `src/modules/admin/services/rbac.ts` + `rbac.test.ts`

```ts
export async function listRoles(): Promise<(Role & { grants: RoleGrant[]; _count: { assignments: number } })[]>
export async function createRole(actorPersonId: string, name: string, description: string | null): Promise<Role>
export async function setRoleGrants(actorPersonId: string, roleId: string, permissions: string[]): Promise<void> // replace-set semantics; validates every permission exists in the registry (allPermissions from MODULES) or is "*"; audit rbac.grants with before/after lists
export async function deleteRole(actorPersonId: string, roleId: string): Promise<void> // refuses isSystem roles (typed error); cascades grants/assignments via FK
export async function listAssignments(): Promise<(RoleAssignment & { role: Role; person: Person | null; department: Department | null; term: Term | null })[]>
export async function createAssignment(actorPersonId: string, input: { roleId: string; personId?: string; departmentId?: string; termId?: string }): Promise<void> // XOR enforced app-side with typed error BEFORE hitting the DB constraint; duplicate grant surfaces typed error (P2002 on the expression index comes back as a generic error: detect via message containing "RoleAssignment_unique_grant" and wrap); audit rbac.assign
export async function deleteAssignment(actorPersonId: string, id: string): Promise<void> // audit rbac.unassign
```

Tests: grant replace-set adds and removes; rejects unknown permission strings; system role deletion refused; XOR violation typed; duplicate assignment typed (insert same twice); assignment + engine integration (after assigning a registry permission to a person via a fresh role, `can()` returns true; after deleteAssignment, false).

- [ ] Red, implement, green; gauntlet. Commit: `feat(admin): rbac service`

---

### Task 10: RBAC pages

**Files:** `src/app/admin/roles/page.tsx`, components `roles-panel.tsx`, `assignment-form.tsx`

Single page, two sections:
- **Roles**: card per role (name, description, system Badge, assignment count). Grants editor: checkbox grid grouped by module (iterate MODULES, list each module's permissions; checked = granted; a separate "*" toggle under a "Platform" group) submitting to setRoleGrants. Create-role inline form. Delete (non-system only) with ConfirmButton.
- **Assignments**: table (role, target person or department, scope term or "Global", created via relation data), delete ConfirmButton per row. Create form: role select, target type radio (person/department) with the corresponding GET-search pattern from Task 8 for person, select for department, term select (blank = global).
- e2e: admin opens /admin/roles, sees "Platform Admin" with the system badge.

- [ ] Gauntlet. Commit: `feat(admin): rbac editor pages`

---

### Task 11: Audit viewer

**Files:** `src/modules/admin/services/audit.ts`, `src/app/admin/audit/page.tsx`, component `audit-table.tsx`

- Service: `queryAudit({ action?, entityType?, actorPersonId?, page?, pageSize? })` paginated desc by createdAt, joining actor name when resolvable (left join via separate person lookup map; actorPersonId has no FK by design).
- Page: `requirePermission("admin.view_audit")`. Filter bar (action contains, entityType select from distinct values, page), table: timestamp (UTC), actor (name or id or "system"), action Badge, entityType/entityId, expandable before/after (`<details>` with `<pre className="text-xs">` JSON). No mutations.
- e2e: admin opens /admin/audit and sees at least one row (imports/smoke tests guarantee data: mirror.drift_corrected exists).

- [ ] Gauntlet. Commit: `feat(admin): audit log viewer`

---

### Task 12: Sync dashboard

**Files:** `src/modules/admin/services/sync.ts` + `sync.test.ts`, `src/app/admin/sync/page.tsx`, component `sync-panel.tsx`

- Service: `syncOverview()` returning `{ mirrorEnabled, targetBaseId, worker: { ok, beatAt }, outbox: { pending, failed, sentLast24h }, failures: Outbox[] (FAILED, latest 20), drift: AuditLog[] (mirror.drift_corrected, latest 20) }`; `retryFailed(actorPersonId)` flips all FAILED rows to PENDING with attempts reset to 0 and lastError cleared, audits `sync.retry_failed` with the count, returns count. Tests: overview shape against seeded rows; retryFailed resets and audits; retry with zero failed rows writes no audit.
- Page: `requirePermission("admin.manage_sync")`. Status cards (mirror enabled?, worker heartbeat with relative time, pending/failed counts), failures table (entityId, attempts, lastError truncated, createdAt) with a single "Retry all failed" ConfirmButton, drift table (when, person id, fields changed). Banner when mirror disabled: "Mirror is disabled. Outbox rows will accumulate until the FA26 cutover enables it." (the known accumulation note from Plan 2, now visible to operators).
- e2e: admin opens /admin/sync and sees the mirror-disabled banner.

- [ ] Gauntlet. Commit: `feat(admin): sync health dashboard`

---

### Task 13: Final verification + PR

- [ ] Full gauntlet: lint, typecheck, `npm test`, `npm run build`, `npm run e2e` (expect 10+: 3 base + admin suite) with no dev server running.
- [ ] Manual sweep with the dev server: click through every admin page as j.carney@yale.edu against the real imported data (662 people, 32 departments); confirm pagination at 27 pages of people; confirm the volunteer account sees no Admin tile and is bounced from /admin/*.
- [ ] Push branch, open the PR:

```bash
gh pr create --title "Plan 3: Admin module" --body "$(cat <<'EOF'
## Summary
- Admin is the first live module: layout, module nav, overview dashboard
- People management (search/edit/create/offboard) with audited mutations that feed the Airtable mirror outbox
- Term lifecycle: create, atomic activate-with-archive swap, clinic-date editing (the FA26 enabler)
- Roster management per term incl. copy-from-term promotion
- RBAC editor over registry-declared permissions; audit log viewer; sync health dashboard with retry
- New shared UI primitives on the Yale Blue token system

## Test Plan
- [ ] CI green (services TDD + e2e)
- [ ] Manual sweep over real imported data
EOF
)"
```

- [ ] Watch CI to green; hand to Jack for review/merge.
