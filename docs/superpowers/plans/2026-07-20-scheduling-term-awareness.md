# Scheduling Term-Awareness (Spec 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a director/scheduler build any in-flight term's schedule from the builder via a `?term=` switcher (live + next editable, archived read-only), instead of the builder being hard-locked to the active term.

**Architecture:** Mirror the shipped cross-term seam: builder services receive an explicit `termId` instead of resolving `getActiveTerm()` internally; the builder page resolves the working term from `?term=` (via the existing `getWorkingTerm`, extended to also resolve archived) and threads it down. Writes to an `ARCHIVED` term are hard-blocked server-side.

**Tech Stack:** Next.js App Router (RSC + inline server actions), Prisma, React `cache()`, Vitest against a local Postgres test DB.

## Global Constraints

- Live term = the single `ACTIVE` term; next term = the single `PLANNING` term; archived terms are read-only. Editable is exactly `term.status !== "ARCHIVED"`.
- Builder services must receive an explicit `termId`; they must NOT resolve `getActiveTerm()` internally.
- Every schedule-mutating write rejects a write whose target term is `ARCHIVED`, using the existing `BuilderValidationError` (there is no `ScheduleStateError` in this codebase).
- Member `/schedule` (`mySchedule`), the clinic-wide day view (`fullSchedule`), and the reminder crons stay on `getActiveTerm()` in this spec (preserves the no-leak property; member self-service is Spec 2).
- Department scope is unchanged (`manageableScheduleDepartmentIds` stays active-term-derived): continuing directors / central schedulers build ahead.
- Behavior identical when only one term is in flight and no `?term` is given.
- No schema change. New per-request resolvers use React `cache()`.
- Tests run against the local Postgres test DB (`havenhub_test` on `:5434`) with `resetDb()` in `beforeEach`; run the FULL `npm run lint` before any push.

---

## File Structure

**Modify:**
- `src/platform/terms/working-term.ts` — `getWorkingTerm` also resolves an archived term by id.
- `src/platform/terms/working-term.test.ts` — cover archived resolution.
- `src/modules/schedule/services/builder.ts` — a `loadEditableTerm(termId)` helper; `termId` threaded into `setAssignment`, `toggleTag`, `setPatientsBooked`, `upsertRhdClinic`; the archived guard added there and to `setAvailabilityOverride`; `builderView` takes `termId`; remove the `getActiveTerm` import.
- `src/modules/schedule/services/builder.test.ts` — pass `termId` in existing calls; add the read-only guard test and a next-term `builderView` test.
- `src/modules/admin/components/term-options.ts` — `buildTermOptions` gains an opt-in `includeArchived`.
- `src/modules/admin/components/term-options.test.ts` — cover `includeArchived` (create it if absent).
- `src/app/(app)/schedule/builder/page.tsx` — `?term` param, resolve `getWorkingTerm`, render the switcher, thread `termId` through `builderView`/hrefs/actions, read-only UI, requests panel only for the live term.

**Create:**
- `src/modules/schedule/components/term-switcher.tsx` — the `<TermSwitcher>` presentational component.

---

## Task 1: `getWorkingTerm` resolves archived terms

**Files:**
- Modify: `src/platform/terms/working-term.ts`
- Test: `src/platform/terms/working-term.test.ts`

**Interfaces:**
- Consumes: `getActiveTerm`, `getNextTerm`, `prisma`.
- Produces: `getWorkingTerm(selectedId?: string): Promise<Term | null>` — unchanged signature; now a `selectedId` naming any real term (including `ARCHIVED`) resolves to that term, still falling back to the live term for an unknown/empty id.

- [ ] **Step 1: Add the failing test**

Append to `src/platform/terms/working-term.test.ts` (it already has a `seed()` creating a live `SU26` + next `FA26`):

```ts
it("resolves an archived term by id (for read-only viewing)", async () => {
  const { live } = await seed();
  const archived = await prisma.term.create({ data: { code: "SP26", name: "Spring", startDate: new Date("2026-01-01"), endDate: new Date("2026-05-01"), status: "ARCHIVED" } });
  expect((await getWorkingTerm(archived.id))?.id).toBe(archived.id);
  // an unknown id still falls back to live
  expect((await getWorkingTerm("nope"))?.id).toBe(live.id);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/platform/terms/working-term.test.ts -t "archived term by id"`
Expected: FAIL (current `getWorkingTerm` returns the live term for an archived id).

- [ ] **Step 3: Extend the resolver**

Replace the body of `getWorkingTerm` in `src/platform/terms/working-term.ts`:

```ts
export const getWorkingTerm = cache(async (selectedId?: string): Promise<Term | null> => {
  const [live, next] = await Promise.all([getActiveTerm(), getNextTerm()]);
  if (selectedId) {
    if (live?.id === selectedId) return live;
    if (next?.id === selectedId) return next;
    // Any other real term (e.g. an archived term selected for read-only viewing in
    // the schedule builder) resolves to itself; an unknown/stale id falls through
    // to the live term below.
    const other = await prisma.term.findUnique({ where: { id: selectedId } });
    if (other) return other;
  }
  return live;
});
```

Add the prisma import at the top if not present: `import { prisma } from "@/platform/db";`.

- [ ] **Step 4: Run the file to verify pass**

Run: `npx vitest run src/platform/terms/working-term.test.ts`
Expected: PASS (all tests, including the new one; the existing "falls back to live" behavior is unchanged for unknown ids).

- [ ] **Step 5: Commit**

```bash
git add src/platform/terms/working-term.ts src/platform/terms/working-term.test.ts
git commit -m "feat(terms): getWorkingTerm resolves archived terms (read-only builder viewing)"
```

---

## Task 2: Builder write services take an explicit `termId` + read-only guard

**Files:**
- Modify: `src/modules/schedule/services/builder.ts`
- Test: `src/modules/schedule/services/builder.test.ts`

**Interfaces:**
- Consumes: nothing new (uses `prisma`, existing `BuilderValidationError`).
- Produces: internal `loadEditableTerm(termId: string): Promise<Term>` (throws `BuilderValidationError` if the term is missing or `ARCHIVED`). `setAssignment`, `toggleTag`, `setPatientsBooked`, `upsertRhdClinic` each gain `termId: string` in their `opts`. `setAvailabilityOverride` gains the archived guard (no signature change).

> Note: this task changes these signatures, which breaks their only production caller (`src/app/(app)/schedule/builder/page.tsx`). That caller is rewired in Task 5. Between this task and Task 5, `npx tsc --noEmit` will report errors in the builder page — expected. This task is verified by its unit tests (`builder.test.ts`), which pass `termId`.

- [ ] **Step 1: Add the failing read-only guard test**

In `src/modules/schedule/services/builder.test.ts`, add a test. Use the existing `createTerm`/`createDepartment`/`createPerson`/`createMembership` helpers; the write services now need a `termId`:

```ts
it("setAssignment rejects a write to an ARCHIVED term (read-only)", async () => {
  const dates = sixSaturdays();
  const archived = await prisma.term.create({
    data: { code: `AR-${Date.now()}`, name: "Archived", startDate: utcNoon(2026, 1, 1), endDate: utcNoon(2026, 5, 1), status: "ARCHIVED", clinicDates: dates },
  });
  const dept = await createDepartment("SRHD");
  const director = await createPerson("Dir");
  await createMembership(director.id, archived.id, dept.id, "DIRECTOR");
  const vol = await createPerson("Vol");
  await createMembership(vol.id, archived.id, dept.id, "VOLUNTEER");

  await expect(
    setAssignment(director.id, { termId: archived.id, departmentId: dept.id, dateKey: isoDateKey(dates[0]), personId: vol.id, role: "VOLUNTEER" }),
  ).rejects.toBeInstanceOf(BuilderValidationError);
  expect(await prisma.shiftAssignment.count()).toBe(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/schedule/services/builder.test.ts -t "ARCHIVED term"`
Expected: FAIL to compile / fail assertion (current `setAssignment` has no `termId` param and no archived guard).

- [ ] **Step 3: Add the `loadEditableTerm` helper**

In `src/modules/schedule/services/builder.ts`, add a `Term` type import and the helper. Change the top import line `import type { RhdClinic } from "@prisma/client";` to include `Term`:

```ts
import type { RhdClinic, Term } from "@prisma/client";
```

Add the helper just below the typed-errors block (after `BuilderValidationError`, around line 50):

```ts
/**
 * Load the term a builder write targets, rejecting a missing term or an
 * ARCHIVED (read-only) term. This is the server-side enforcement of the
 * archived-is-read-only rule: even a stale tab or crafted request cannot mutate
 * a closed term's schedule.
 */
async function loadEditableTerm(termId: string): Promise<Term> {
  const term = await prisma.term.findUnique({ where: { id: termId } });
  if (!term) throw new BuilderValidationError("Unknown term.");
  if (term.status === "ARCHIVED") throw new BuilderValidationError("This term is archived and read-only.");
  return term;
}
```

- [ ] **Step 4: Thread `termId` into the four write services**

For each of `setAssignment`, `toggleTag`, `setPatientsBooked`, `upsertRhdClinic`: (a) add `termId: string;` to the `opts` object type, and (b) replace the two-line active-term resolution

```ts
  const term = await getActiveTerm();
  if (!term) throw new BuilderValidationError("No active term.");
```

with

```ts
  const term = await loadEditableTerm(opts.termId);
```

Everything downstream (`term.clinicDates`, `term.id`, the `dateKey` validation, the writes stamped with `term.id`) stays exactly as-is. Concretely:
- `setAssignment` (opts around line 151): add `termId: string;` to the opts type; swap the block at lines 167-168.
- `toggleTag` (opts around line 272): add `termId: string;`; swap 286-287.
- `setPatientsBooked` (opts around line 328): add `termId: string;`; swap 332-333.
- `upsertRhdClinic` (opts around line 473): add `termId: string;`; swap 490-491.

- [ ] **Step 5: Add the archived guard to `setAvailabilityOverride`**

`setAvailabilityOverride` already loads `membership` with `include: { term: true }`. Right after the `scopeCheck(actor, membership.departmentId)` line (around line 392), add:

```ts
  if (membership.term.status === "ARCHIVED") {
    throw new BuilderValidationError("This term is archived and read-only.");
  }
```

(`acknowledgeAvailability` and the RHD attending roster are left unguarded per the spec.)

- [ ] **Step 6: Update the existing write-service test calls**

In `builder.test.ts`, every existing call to `setAssignment`, `toggleTag`, `setPatientsBooked`, `upsertRhdClinic` must now pass `termId: term.id` (the fixture's active term id). Add `termId: term.id,` (or the fixture's term variable) to each `opts` object at those call sites. (Search the file for these four function names and add the field.)

- [ ] **Step 7: Run the full builder test file**

Run: `npx vitest run src/modules/schedule/services/builder.test.ts`
Expected: PASS — the new archived-guard test plus all existing tests (now passing `termId`). `builderView` tests still pass because Task 2 has not changed `builderView` yet (it still resolves `getActiveTerm`).

- [ ] **Step 8: Commit**

```bash
git add src/modules/schedule/services/builder.ts src/modules/schedule/services/builder.test.ts
git commit -m "feat(schedule): builder write services take an explicit termId + archived read-only guard"
```

---

## Task 3: `builderView` takes an explicit `termId`

**Files:**
- Modify: `src/modules/schedule/services/builder.ts`
- Test: `src/modules/schedule/services/builder.test.ts`

**Interfaces:**
- Consumes: `loadEditableTerm` is NOT used here (viewing an archived term read-only is allowed); `builderView` loads the term by id directly.
- Produces: `builderView(viewerPersonId, { departmentId?, dateKey?, now?, termId })` — `termId` is required; it loads that term's roster/dates/assignments. Removes the last `getActiveTerm` use from `builder.ts`.

- [ ] **Step 1: Add the failing test**

In `builder.test.ts`, add a test that builds a view for a NEXT (`PLANNING`) term while a different term is `ACTIVE`:

```ts
it("builderView loads the working (next) term's roster and dates", async () => {
  const dates = sixSaturdays();
  await createTerm(dates, "ACTIVE"); // a live term exists but is not the working term
  const next = await createTerm(dates, "PLANNING");
  const dept = await createDepartment("SRHD");
  const director = await createPerson("Dir");
  await createMembership(director.id, next.id, dept.id, "DIRECTOR");
  const vol = await createPerson("Vol");
  await createMembership(vol.id, next.id, dept.id, "VOLUNTEER");

  const view = await builderView(director.id, { departmentId: dept.id, termId: next.id, now: dates[0] });
  expect(view.clinicDates.length).toBe(6);
  expect(view.members.map((m) => m.person.id)).toContain(vol.id);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/schedule/services/builder.test.ts -t "working (next) term"`
Expected: FAIL to compile (`builderView` opts has no `termId`).

- [ ] **Step 3: Change `builderView` to load the working term**

In `builderView` (around line 634): add `termId: string;` to the `opts` type (the object at line 636). Replace the active-term load at lines 682-683

```ts
  const term = await getActiveTerm();
  if (!term) {
```

with a load-by-id (no archived guard — reading an archived term is allowed):

```ts
  const term = await prisma.term.findUnique({ where: { id: opts.termId } });
  if (!term) {
```

The rest of the function (the empty-view branch, `const { clinicDates } = term;`, date/assignment loading with `term.id`) is unchanged.

- [ ] **Step 4: Remove the now-unused `getActiveTerm` import**

`getActiveTerm` is no longer referenced anywhere in `builder.ts` (Task 2 removed it from the write services; this task removed the last use in `builderView`). Delete the import line `import { getActiveTerm } from "@/platform/terms/active-term";` (line 30).

- [ ] **Step 5: Run the full builder test file + lint the service**

Run: `npx vitest run src/modules/schedule/services/builder.test.ts`
Expected: PASS (new test + all prior).
Run: `npx eslint src/modules/schedule/services/builder.ts`
Expected: clean (no unused `getActiveTerm`).

- [ ] **Step 6: Commit**

```bash
git add src/modules/schedule/services/builder.ts src/modules/schedule/services/builder.test.ts
git commit -m "feat(schedule): builderView takes an explicit working termId"
```

---

## Task 4: `buildTermOptions` archived opt-in + `<TermSwitcher>` component

**Files:**
- Modify: `src/modules/admin/components/term-options.ts`
- Test: `src/modules/admin/components/term-options.test.ts` (create if absent)
- Create: `src/modules/schedule/components/term-switcher.tsx`

**Interfaces:**
- Consumes: `buildTermOptions(terms, opts?)`.
- Produces: `buildTermOptions(terms, opts?: { includeArchived?: boolean }): TermOption[]` — default behavior unchanged (drops archived); with `includeArchived: true`, appends archived terms labeled `"{code} (archived)"`. `<TermSwitcher>` renders the options as links.

- [ ] **Step 1: Write the failing `buildTermOptions` test**

Create/append `src/modules/admin/components/term-options.test.ts`:

```ts
import { expect, it } from "vitest";
import { buildTermOptions } from "./term-options";

const t = (id: string, code: string, status: "ACTIVE" | "PLANNING" | "ARCHIVED") => ({ id, code, status });

it("omits archived terms by default (unchanged behavior)", () => {
  const opts = buildTermOptions([t("1", "SU26", "ACTIVE"), t("2", "SP26", "ARCHIVED")]);
  expect(opts.map((o) => o.value)).toEqual(["", "1"]); // Global + active only
});

it("includes archived terms, labeled, when asked", () => {
  const opts = buildTermOptions([t("1", "SU26", "ACTIVE"), t("2", "SP26", "ARCHIVED")], { includeArchived: true });
  expect(opts.find((o) => o.value === "2")?.label).toBe("SP26 (archived)");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/admin/components/term-options.test.ts`
Expected: FAIL (`buildTermOptions` takes no options arg; archived is dropped).

- [ ] **Step 3: Extend `buildTermOptions`**

In `src/modules/admin/components/term-options.ts`, change the signature and the archived handling:

```ts
export function buildTermOptions(
  terms: Pick<Term, "id" | "code" | "status">[],
  opts: { includeArchived?: boolean } = {},
): TermOption[] {
  const options: TermOption[] = [{ value: "", label: "Global" }];
  for (const t of terms) {
    if (t.status === "ARCHIVED") {
      if (opts.includeArchived) options.push({ value: t.id, label: `${t.code} (archived)` });
      continue;
    }
    const label = t.status === "PLANNING" ? `${t.code} (not yet active)` : t.code;
    options.push({ value: t.id, label });
  }
  return options;
}
```

- [ ] **Step 4: Run the test to verify pass**

Run: `npx vitest run src/modules/admin/components/term-options.test.ts`
Expected: PASS (both tests). Existing RBAC callers pass no `opts`, so their behavior is unchanged.

- [ ] **Step 5: Create the `<TermSwitcher>` component**

Create `src/modules/schedule/components/term-switcher.tsx`. It is presentational: it renders each term option as a link, marking the selected one and the read-only (archived) ones. URL construction is owned by the caller via `hrefForTerm`.

```tsx
import Link from "next/link";
import type { TermOption } from "@/modules/admin/components/term-options";

/**
 * Term switcher for the schedule builder. Renders the working-term options as
 * links; the caller supplies hrefForTerm so the builder page owns URL params
 * (dept/view/etc.). The "" (Global) option from buildTermOptions is dropped
 * here — the builder always works on a concrete term (the live one by default).
 */
export function TermSwitcher({
  options,
  selectedId,
  liveTermId,
  hrefForTerm,
}: {
  options: TermOption[];
  selectedId: string;
  liveTermId: string | null;
  hrefForTerm: (termId: string | null) => string;
}) {
  const terms = options.filter((o) => o.value !== "");
  return (
    <nav aria-label="Working term" className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Term</span>
      {terms.map((o) => {
        const isSelected = o.value === selectedId;
        const isLive = o.value === liveTermId;
        return (
          <Link
            key={o.value}
            href={hrefForTerm(isLive ? null : o.value)}
            aria-current={isSelected ? "page" : undefined}
            className={`rounded-lg border px-2.5 py-1 text-sm font-semibold ${
              isSelected ? "border-brand bg-brand-faint text-brand-fg" : "border-border text-foreground-soft hover:border-brand"
            }`}
          >
            {o.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 6: Typecheck the new files**

Run: `npx tsc --noEmit 2>&1 | grep -E "term-options|term-switcher" || echo "no errors in the new/changed files"`
Expected: no errors in `term-options.ts` / `term-switcher.tsx`. (The builder page still shows expected errors from Tasks 2-3 until Task 5.)

- [ ] **Step 7: Commit**

```bash
git add src/modules/admin/components/term-options.ts src/modules/admin/components/term-options.test.ts src/modules/schedule/components/term-switcher.tsx
git commit -m "feat(schedule): buildTermOptions archived opt-in + TermSwitcher component"
```

---

## Task 5: Wire the builder page to the working term

**Files:**
- Modify: `src/app/(app)/schedule/builder/page.tsx`

**Interfaces:**
- Consumes: `getWorkingTerm` (Task 1), the term-threaded `builderView` + write services (Tasks 2-3), `buildTermOptions` + `<TermSwitcher>` (Task 4).
- Produces: no new exports.

This is UI wiring with no unit test; the deliverable is `tsc` + full `npm run lint` clean and the term threaded end-to-end. (E2E is Playwright/manual, which cannot run locally here.)

- [ ] **Step 1: Read the file, then add imports + the `term` search param**

Read `src/app/(app)/schedule/builder/page.tsx` fully first. Add imports near the other imports:

```ts
import { getWorkingTerm } from "@/platform/terms/working-term";
import { getActiveTerm } from "@/platform/terms/active-term";
import { buildTermOptions } from "@/modules/admin/components/term-options";
import { TermSwitcher } from "@/modules/schedule/components/term-switcher";
import { prisma } from "@/platform/db";
```

Add `term?: string;` to the `PageProps.searchParams` type (around line 90-98) and to `HrefParams` (around 105-113). In `buildHref` (line 115), add near the other params:

```ts
  if (p.term) params.set("term", p.term);
```

- [ ] **Step 2: Resolve the working term and thread it into `builderView`**

After `const sp = await searchParams;` and the existing param parsing (around line 139-145), resolve the working term:

```ts
  const [workingTerm, liveTerm] = await Promise.all([getWorkingTerm(sp.term), getActiveTerm()]);
  if (!workingTerm) {
    // No active term (and no valid ?term): nothing to build.
    return (
      <div>
        <div className="rounded-2xl bg-brand px-8 py-6 text-white mb-8">
          <p className="text-xs font-semibold uppercase tracking-widest text-white/60 mb-1">Schedule Builder</p>
          <h1 className="text-2xl font-bold tracking-tight">No active term</h1>
          <p className="text-sm text-white/70 mt-1">There is no term to build a schedule for yet.</p>
        </div>
      </div>
    );
  }
  const editable = workingTerm.status !== "ARCHIVED";
  const termParam = workingTerm.id === liveTerm?.id ? undefined : workingTerm.id; // omit ?term for the live term
```

Change the `builderView` call (line 154-157) to pass the term:

```ts
  const data = await builderView(session.personId, {
    departmentId: deptParam,
    dateKey: dateParam,
    termId: workingTerm.id,
  });
```

- [ ] **Step 3: Thread `term` through the `href` helper + render the switcher**

In the `href` closure (line 179-188), add `term: termParam` to the defaults:

```ts
  function href(overrides: HrefParams): string {
    return buildHref("/schedule/builder", {
      dept: dept.id,
      date: selectedDateKey,
      view,
      mode,
      gmode,
      term: termParam,
      ...overrides,
    });
  }
```

Build the switcher options (fetch the live + next + recent archived terms) and render `<TermSwitcher>` near the top of the returned layout (just under the page header). Add, after `const dept = selectedDepartment!;` (line 172):

```ts
  const switcherTerms = await prisma.term.findMany({
    orderBy: { startDate: "desc" },
    take: 8, // the 8 most recent terms: live + next + a bounded set of recent archived
    select: { id: true, code: true, status: true },
  });
  const termOptions = buildTermOptions(switcherTerms, { includeArchived: true });
```

Then render it in the JSX header area (choose the existing header container):

```tsx
  <TermSwitcher
    options={termOptions}
    selectedId={workingTerm.id}
    liveTermId={liveTerm?.id ?? null}
    hrefForTerm={(termId) => buildHref("/schedule/builder", { dept: dept.id, view, mode, gmode, term: termId ?? undefined })}
  />
```

(Switching term resets `date` — clinic dates differ per term — but keeps the department, which is a shared entity.)

- [ ] **Step 4: Thread `termId` into the write actions + preserve `term` in their redirects**

Each inline server action (`assignAction`, `unassignAction`, `toggleTagAction`, `patientsBookedAction`, `rhdClinicAction`) must (a) pass `termId: workingTerm.id` into its service call, and (b) include `term: termParam` in every `buildHref` it builds (the `base`, `errorRedirect`, and `successRedirect`). The actions already close over `dept`, `selectedDateKey`, `view`, `mode`, `gmode`; they now also close over `workingTerm`/`termParam`.

Example for `assignAction` — the `work` call becomes:

```ts
      work: () => setAssignment(actor.personId, { termId: workingTerm.id, departmentId, dateKey, personId, role }),
```

and each `buildHref(...)` in that action gains `term: termParam` alongside `dept`/`date`/`view`/`mode`/`gmode`. Apply the same two changes to `unassignAction` (→ `setAssignment` with `role: null`), `toggleTagAction` (→ `toggleTag`), `patientsBookedAction` (→ `setPatientsBooked`), and `rhdClinicAction` (→ `upsertRhdClinic`).

The availability actions (`saveOverrideAction`, `clearOverrideAction`, `acknowledgeAction`) call `setAvailabilityOverride`/`acknowledgeAvailability`, which derive the term from the membership — they need no `termId`, but still add `term: termParam` to their `buildHref` redirects so navigation stays on the working term. `addAttendingAction` is term-agnostic — add `term: termParam` to its redirects only.

- [ ] **Step 5: Read-only UI for archived + requests panel only for the live term**

- Wrap the write controls so they render only when `editable`. When `!editable`, render a banner instead, e.g. near the top of the grid/day area:

```tsx
  {!editable && (
    <div className="mb-4 rounded-xl border border-border bg-muted px-4 py-3 text-sm text-foreground-soft">
      Viewing <span className="font-semibold text-foreground">{workingTerm.name}</span> — archived, read-only.
    </div>
  )}
```

  Gate the interactive forms (assign/unassign, tag toggles, patient-count input, RHD clinic edit, availability override/acknowledge) on `editable` (render them only when `editable`; the read-only view still shows the grid + assignments).
- Gate the requests panel on the working term being the live term. Change the requests load (lines 174-177) so it only runs for the live term:

```ts
  const isLiveTerm = workingTerm.id === liveTerm?.id;
  const canManageRequests = isLiveTerm && (await canManageRequestsForDept(session.personId, dept.id));
  const requestRows = canManageRequests ? await listDepartmentRequests(session.personId, dept.id) : [];
```

  (When not on the live term, `requestRows` is empty and the panel renders nothing, matching the spec.)

- [ ] **Step 6: Typecheck + full lint**

Run: `npx tsc --noEmit`
Expected: no errors (Tasks 2-3's intermediate breakage is now resolved).
Run: `npx eslint "src/app/(app)/schedule/builder/page.tsx"`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/schedule/builder/page.tsx"
git commit -m "feat(schedule): term-aware builder page (switcher, term threading, archived read-only)"
```

---

## Final verification

- [ ] **Run the affected suites**

Run: `npx vitest run src/platform/terms src/modules/schedule/services/builder.test.ts src/modules/admin/components/term-options.test.ts`
Expected: PASS.

- [ ] **Full typecheck + lint (pre-push gate)**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Manual smoke (optional, if a dev DB with two terms exists):** as a director, open `/schedule/builder`, switch to the next term via the switcher, build assignments/tags/patient-counts (they save against the next term), switch to an archived term (controls hidden, a write attempt is rejected), and confirm the default (live-term) view is unchanged.
