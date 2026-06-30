# Recruitment Cycle Lifecycle (reopen + archive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two missing recruitment-cycle lifecycle transitions — reopen (CLOSED→OPEN) and archive (CLOSED→ARCHIVED) — so a closed cycle is no longer a dead end (#104) and the ARCHIVED state becomes reachable (#105).

**Architecture:** Two new service functions in `cycles.ts` (mirroring `closeCycle`), two thin server actions (mirroring `closeCycleAction`), and overview-page buttons shown only for CLOSED cycles (Reopen = `SubmitButton`, Archive = two-click `ConfirmButton`). No schema change — `CycleStatus.ARCHIVED` already exists.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma, Vitest, Tailwind.

## Global Constraints

- **No em-dashes** in prose, UI copy, or comments. Use other punctuation.
- Product name is "HAVEN Hub" (two words) in prose/UI; identifiers stay `havenhub`.
- **No schema migration** in this change. Do NOT run `prisma migrate dev` (it folds in pre-existing repo drift) and do NOT add a migration.
- **Neon safety:** the repo `.env` points `DATABASE_URL` / `DATABASE_URL_UNPOOLED` at the shared Neon DB, and the Prisma CLI reads `.env`. NEVER run a Prisma CLI command without inline-overriding both vars to the local test DB. Vitest itself is safe (it overrides `DATABASE_URL` in `vitest.setup.ts`).
- Permission gate for all cycle lifecycle actions: `recruitment.manage_cycles`.
- Audit every state transition via `recordAudit`.

---

## Task 0: Worktree test database (prerequisite, no commit)

A dedicated per-worktree test DB avoids the cross-worktree deadlock on the shared `havenhub_test` and guarantees the schema matches this branch.

**Files:** none (environment only).

- [ ] **Step 1: Create the worktree test DB (idempotent)**

```bash
psql "postgresql://haven:haven_dev@localhost:5434/postgres" \
  -c 'CREATE DATABASE havenhub_test_cyclelife;' 2>/dev/null || true
```

- [ ] **Step 2: Apply migrations to it (inline override — never touches Neon)**

```bash
DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_cyclelife' \
DATABASE_URL_UNPOOLED='postgresql://haven:haven_dev@localhost:5434/havenhub_test_cyclelife' \
npx prisma migrate deploy
```

Expected: "All migrations have been successfully applied." (or "No pending migrations").

- [ ] **Step 3: Export the test DB for every later test command**

```bash
export TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_cyclelife'
```

All `npx vitest` invocations below assume this is exported in the shell.

---

## Task 1: `reopenCycle` service (CLOSED → OPEN, clears a stale closesAt)

**Files:**
- Modify: `src/modules/recruitment/services/cycles.ts` (add after `closeCycle`, ~line 112)
- Test: `src/modules/recruitment/services/cycles.test.ts` (new `describe` block)

**Interfaces:**
- Consumes: existing `createCycle`, `publishCycle`, `closeCycle`, `listCycles`, `CyclePublishError` from `./cycles`; `prisma`; `recordAudit`.
- Produces: `reopenCycle(id: string, actorId: string): Promise<RecruitmentCycle>` — sets status OPEN; if `closesAt` is non-null and `< now`, also clears `closesAt`; writes a `recruitment.cycle_reopen` audit. Throws `CyclePublishError` if missing or not CLOSED.

- [ ] **Step 1: Write the failing tests**

Add this block to `src/modules/recruitment/services/cycles.test.ts`. Add `reopenCycle` to the existing import from `./cycles` (line 4-6).

```ts
describe("reopenCycle", () => {
  async function closedCycle(slug: string, overrides: { opensAt?: Date | null; closesAt?: Date | null } = {}) {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "DIRECTOR", termId: term.id, title: "R", publicSlug: slug,
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    await publishCycle(cycle.id, person.id);
    await closeCycle(cycle.id, person.id);
    if (Object.keys(overrides).length > 0) {
      await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: overrides });
    }
    return { person, cycle };
  }

  it("reopens a CLOSED cycle back to OPEN", async () => {
    const { person, cycle } = await closedCycle("reopen-basic");
    const reopened = await reopenCycle(cycle.id, person.id);
    expect(reopened.status).toBe("OPEN");
  });

  it("writes a recruitment.cycle_reopen audit entry", async () => {
    const { person, cycle } = await closedCycle("reopen-audit");
    await reopenCycle(cycle.id, person.id);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: cycle.id, action: "recruitment.cycle_reopen" } });
    expect(audit).not.toBeNull();
  });

  it("clears a closesAt that is already in the past on reopen", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { person, cycle } = await closedCycle("reopen-stale", { closesAt: past });
    const reopened = await reopenCycle(cycle.id, person.id);
    expect(reopened.status).toBe("OPEN");
    expect(reopened.closesAt).toBeNull();
  });

  it("leaves a future closesAt untouched on reopen", async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const { person, cycle } = await closedCycle("reopen-future", { closesAt: future });
    const reopened = await reopenCycle(cycle.id, person.id);
    expect(reopened.closesAt?.getTime()).toBe(future.getTime());
  });

  it("leaves opensAt untouched on reopen", async () => {
    const opens = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { person, cycle } = await closedCycle("reopen-opens", { opensAt: opens });
    const reopened = await reopenCycle(cycle.id, person.id);
    expect(reopened.opensAt?.getTime()).toBe(opens.getTime());
  });

  it("rejects reopening a DRAFT cycle", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "reopen-draft",
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    await expect(reopenCycle(cycle.id, person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects reopening an OPEN cycle", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "DIRECTOR", termId: term.id, title: "O", publicSlug: "reopen-open",
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    await publishCycle(cycle.id, person.id);
    await expect(reopenCycle(cycle.id, person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects a missing cycle", async () => {
    const { person } = await seedTermAndPerson();
    await expect(reopenCycle("missing", person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/modules/recruitment/services/cycles.test.ts -t reopenCycle
```

Expected: FAIL — `reopenCycle is not a function` / import error.

- [ ] **Step 3: Implement `reopenCycle`**

Insert into `src/modules/recruitment/services/cycles.ts` immediately after `closeCycle` (after line 112):

```ts
/** Reopen a CLOSED cycle (CLOSED -> OPEN), reversing an accidental or premature
 *  close. A pure status flip: the cycle was already valid when first published,
 *  so publish-time validation is not re-run. One exception: the application
 *  window is a live soft gate, so if closesAt is already in the past we clear it,
 *  otherwise the reopened public form would stay shut and reopen would appear to
 *  do nothing. opensAt and a future closesAt are left as-is. */
export async function reopenCycle(id: string, actorId: string): Promise<RecruitmentCycle> {
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id } });
  if (!cycle) throw new CyclePublishError("Cycle not found.");
  if (cycle.status !== "CLOSED") throw new CyclePublishError("Only a CLOSED cycle can be reopened.");

  const clearStaleClose = cycle.closesAt !== null && cycle.closesAt < new Date();
  const updated = await prisma.recruitmentCycle.update({
    where: { id },
    data: { status: "OPEN", ...(clearStaleClose ? { closesAt: null } : {}) },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.cycle_reopen",
    entityType: "RecruitmentCycle",
    entityId: id,
    ...(clearStaleClose
      ? { before: { closesAt: cycle.closesAt?.toISOString() ?? null }, after: { closesAt: null } }
      : {}),
  });
  return updated;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/modules/recruitment/services/cycles.test.ts -t reopenCycle
```

Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/cycles.ts src/modules/recruitment/services/cycles.test.ts
git commit -m "feat(recruitment): reopenCycle service (CLOSED -> OPEN) (#104)"
```

---

## Task 2: `archiveCycle` service (CLOSED → ARCHIVED)

**Files:**
- Modify: `src/modules/recruitment/services/cycles.ts` (add after `reopenCycle`)
- Test: `src/modules/recruitment/services/cycles.test.ts` (new `describe` block)

**Interfaces:**
- Consumes: same as Task 1, plus `reopenCycle` now exists.
- Produces: `archiveCycle(id: string, actorId: string): Promise<RecruitmentCycle>` — sets status ARCHIVED; writes a `recruitment.cycle_archive` audit. Throws `CyclePublishError` if missing or not CLOSED.

- [ ] **Step 1: Write the failing tests**

Add `archiveCycle` to the `./cycles` import. Add this block to `cycles.test.ts`:

```ts
describe("archiveCycle", () => {
  async function closedCycle(slug: string) {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "DIRECTOR", termId: term.id, title: "A", publicSlug: slug,
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    await publishCycle(cycle.id, person.id);
    await closeCycle(cycle.id, person.id);
    return { person, cycle };
  }

  it("archives a CLOSED cycle", async () => {
    const { person, cycle } = await closedCycle("archive-basic");
    const archived = await archiveCycle(cycle.id, person.id);
    expect(archived.status).toBe("ARCHIVED");
  });

  it("writes a recruitment.cycle_archive audit entry", async () => {
    const { person, cycle } = await closedCycle("archive-audit");
    await archiveCycle(cycle.id, person.id);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: cycle.id, action: "recruitment.cycle_archive" } });
    expect(audit).not.toBeNull();
  });

  it("drops the archived cycle out of listCycles", async () => {
    const { person, cycle } = await closedCycle("archive-listed");
    await archiveCycle(cycle.id, person.id);
    const all = await listCycles();
    expect(all.find((c) => c.id === cycle.id)).toBeUndefined();
  });

  it("rejects archiving a DRAFT cycle", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "archive-draft",
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    await expect(archiveCycle(cycle.id, person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects archiving an OPEN cycle", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "DIRECTOR", termId: term.id, title: "O", publicSlug: "archive-open",
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    await publishCycle(cycle.id, person.id);
    await expect(archiveCycle(cycle.id, person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects a missing cycle", async () => {
    const { person } = await seedTermAndPerson();
    await expect(archiveCycle("missing", person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/modules/recruitment/services/cycles.test.ts -t archiveCycle
```

Expected: FAIL — `archiveCycle is not a function`.

- [ ] **Step 3: Implement `archiveCycle`**

Insert into `cycles.ts` immediately after `reopenCycle`:

```ts
/** Archive a CLOSED cycle (CLOSED -> ARCHIVED), the terminal retire step. Drops
 *  the cycle out of listCycles and activates the ARCHIVED guards in
 *  setCycleDepartments, releaseDecisions, and onboarding. Terminal: there is no
 *  transition out of ARCHIVED. */
export async function archiveCycle(id: string, actorId: string): Promise<RecruitmentCycle> {
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id } });
  if (!cycle) throw new CyclePublishError("Cycle not found.");
  if (cycle.status !== "CLOSED") throw new CyclePublishError("Only a CLOSED cycle can be archived.");
  const updated = await prisma.recruitmentCycle.update({ where: { id }, data: { status: "ARCHIVED" } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.cycle_archive", entityType: "RecruitmentCycle", entityId: id });
  return updated;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/modules/recruitment/services/cycles.test.ts -t archiveCycle
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/cycles.ts src/modules/recruitment/services/cycles.test.ts
git commit -m "feat(recruitment): archiveCycle service (CLOSED -> ARCHIVED) (#105)"
```

---

## Task 3: Server actions for reopen + archive

**Files:**
- Modify: `src/app/(app)/recruitment/actions.ts` (import + two new actions)

**Interfaces:**
- Consumes: `reopenCycle`, `archiveCycle` from `@/modules/recruitment/services/cycles`; existing `requirePermission`, `redirect`, `revalidatePath`, `CyclePublishError`.
- Produces: `reopenCycleAction(cycleId: string)` and `archiveCycleAction(cycleId: string)` — server actions usable as `action.bind(null, id)` form handlers.

- [ ] **Step 1: Extend the `cycles` import**

In `src/app/(app)/recruitment/actions.ts`, update the import block (lines 5-7) to include the two new functions:

```ts
import {
  createCycle, publishCycle, closeCycle, reopenCycle, archiveCycle, setAcceptsRenewals,
  setApplicationWindow, setCycleDepartments, CyclePublishError,
} from "@/modules/recruitment/services/cycles";
```

(Preserve any other names already in that import — `setApplicationWindow` exists on main; keep it. Do not drop existing imports.)

- [ ] **Step 2: Add the two actions after `closeCycleAction`**

```ts
export async function reopenCycleAction(cycleId: string) {
  const person = await requirePermission("recruitment.manage_cycles");
  try {
    await reopenCycle(cycleId, person.personId);
  } catch (err) {
    if (err instanceof CyclePublishError) {
      redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath(`/recruitment/cycles/${cycleId}`);
}

export async function archiveCycleAction(cycleId: string) {
  const person = await requirePermission("recruitment.manage_cycles");
  try {
    await archiveCycle(cycleId, person.personId);
  } catch (err) {
    if (err instanceof CyclePublishError) {
      redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath(`/recruitment/cycles/${cycleId}`);
}
```

- [ ] **Step 3: Typecheck the actions file**

```bash
npx tsc --noEmit
```

Expected: no errors (or only pre-existing errors unrelated to this file — see Task 5 for the full gate).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/recruitment/actions.ts"
git commit -m "feat(recruitment): reopen + archive cycle actions (#104, #105)"
```

---

## Task 4: Overview page buttons + ARCHIVED read-only

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/page.tsx`

**Interfaces:**
- Consumes: `reopenCycleAction`, `archiveCycleAction` from `../../actions`; `ConfirmButton` from `@/platform/ui/confirm-button`.
- Produces: UI only.

- [ ] **Step 1: Add the two actions + ConfirmButton to imports**

Update the actions import (page line 6) to include the two new actions, and add the ConfirmButton import alongside the other `@/platform/ui/*` imports:

```ts
import { publishCycleAction, closeCycleAction, reopenCycleAction, archiveCycleAction, toggleRenewalsAction, setTrainingCycleAction, updateQuizSettingsAction, setCycleDepartmentsAction, setApplicationWindowAction } from "../../actions";
```

```ts
import { ConfirmButton } from "@/platform/ui/confirm-button";
```

- [ ] **Step 2: Complete the `statusTone` map**

Replace (page line 18):

```ts
const statusTone = { DRAFT: "default", OPEN: "success", CLOSED: "warning" } as const;
```

with:

```ts
const statusTone = { DRAFT: "default", OPEN: "success", CLOSED: "warning", ARCHIVED: "default" } as const;
```

- [ ] **Step 3: Make the Departments form read-only when ARCHIVED**

Replace the Departments `<form>...</form>` (page lines 110-124) with a conditional: editable form for non-archived, read-only chips when archived.

```tsx
        {cycle.status === "ARCHIVED" ? (
          <div className="flex flex-wrap gap-2">
            {cycle.departments.length === 0 ? (
              <p className="text-sm text-subtle-foreground">No departments.</p>
            ) : (
              cycle.departments.map((c) => (
                <span key={c} className="rounded-lg border border-border px-2 py-1 text-sm text-foreground">{c}</span>
              ))
            )}
          </div>
        ) : (
          <form action={setCycleDepartmentsAction.bind(null, id)} className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {deptOptions.map((d) => (
                <label key={d.code} className="flex items-center gap-2 text-sm">
                  <Checkbox name="departments" value={d.code} defaultChecked={selected.has(d.code)} />
                  <span className="text-foreground">{d.code}{d.name ? ` - ${d.name}` : ""}</span>
                  <span className="text-xs text-subtle-foreground">{counts.get(d.code) ? `${counts.get(d.code)} applicant${counts.get(d.code) === 1 ? "" : "s"}` : ""}{!d.known ? " · not in department list" : ""}</span>
                </label>
              ))}
              {deptOptions.length === 0 && <p className="text-sm text-subtle-foreground">No departments configured.</p>}
            </div>
            <FormActions>
              <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save departments</SubmitButton>
            </FormActions>
          </form>
        )}
```

- [ ] **Step 4: Add Reopen + Archive buttons and the archived note**

In the lifecycle action row (page lines 150-168), after the `cycle.status === "OPEN"` Close block and before the renewals toggle block, add:

```tsx
        {cycle.status === "CLOSED" && (
          <>
            <form action={reopenCycleAction.bind(null, id)}>
              <SubmitButton size="sm" variant="outline" pendingLabel="Reopening…">Reopen</SubmitButton>
            </form>
            <form action={archiveCycleAction.bind(null, id)}>
              <ConfirmButton label="Archive" confirmLabel="Archive this cycle?" size="sm" />
            </form>
          </>
        )}
        {cycle.status === "ARCHIVED" && (
          <p className="text-sm text-subtle-foreground">This cycle is archived and read-only.</p>
        )}
```

- [ ] **Step 5: Verify the page compiles (typecheck + lint)**

```bash
npx tsc --noEmit && npx next lint --file "src/app/(app)/recruitment/cycles/[id]/page.tsx"
```

Expected: no new errors. (If `next lint --file` is unsupported in this version, fall back to `npx eslint "src/app/(app)/recruitment/cycles/[id]/page.tsx"`.)

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/page.tsx"
git commit -m "feat(recruitment): reopen/archive buttons + archived read-only on cycle overview (#104, #105)"
```

---

## Task 5: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Run the full recruitment cycles test file**

```bash
npx vitest run src/modules/recruitment/services/cycles.test.ts
```

Expected: PASS (all pre-existing + 14 new tests).

- [ ] **Step 2: Run the broader recruitment test suite (catch guard regressions)**

```bash
npx vitest run src/modules/recruitment
```

Expected: PASS (decisions/onboarding ARCHIVED guards still hold).

- [ ] **Step 3: Typecheck + production build**

```bash
npx tsc --noEmit && npm run build
```

Expected: clean typecheck; build succeeds. (If a stale shared Prisma client surfaces unrelated tsc errors per the known worktree hazard, confirm they are not in files this plan touched.)

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin fix/recruitment-cycle-lifecycle
gh pr create --repo HAVEN-Free-Clinic/HAVENHub \
  --title "fix(recruitment): complete cycle lifecycle with reopen + archive (#104, #105)" \
  --body "Closes #104. Closes #105.

Adds the two missing recruitment-cycle transitions:
- **reopenCycle** (CLOSED -> OPEN): reverses an accidental/premature close; clears a closesAt that is already in the past so the reopen takes effect.
- **archiveCycle** (CLOSED -> ARCHIVED): terminal retire step; makes the previously-dead ARCHIVED guards (listCycles, setCycleDepartments, releaseDecisions, onboarding) live.

Surfaced on the cycle overview for CLOSED cycles (Reopen button + Archive ConfirmButton). ARCHIVED added to statusTone; archived cycles render read-only. No schema change (ARCHIVED already in the enum).

See spec: docs/superpowers/specs/2026-06-30-recruitment-cycle-lifecycle-design.md"
```

---

## Self-Review

- **Spec coverage:** reopenCycle (Task 1) ✓, archiveCycle (Task 2) ✓, actions (Task 3) ✓, statusTone + buttons + archived read-only (Task 4) ✓, no migration ✓, tests for every listed case (Tasks 1-2) ✓, CLOSED-only archive ✓, clear-past-closesAt ✓.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `reopenCycle`/`archiveCycle` signatures identical across service def, test import, action import, and page import. `CyclePublishError` reused for all guards. Action names `reopenCycleAction`/`archiveCycleAction` consistent between Task 3 (def) and Task 4 (page import).
