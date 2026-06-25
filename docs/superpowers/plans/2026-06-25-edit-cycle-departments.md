# Edit Cycle Departments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the recruitment team edit a cycle's departments after creation (add or remove), including on a CLOSED cycle, via a multi-select on the cycle overview page.

**Architecture:** A guarded service `setCycleDepartments` (mirrors `setAcceptsRenewals`) updates `RecruitmentCycle.departments` on any non-archived cycle and reports which removed departments still had applicants. A server action wires a checkbox multi-select on the cycle overview page to that service, with success/warning alerts. No schema change.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma/Postgres, Vitest (integration tests on a test DB), Tailwind.

## Global Constraints

- Product name "HAVEN Hub" is two words in prose/UI; identifiers stay `havenhub`.
- No em-dashes in copy or comments; use other punctuation.
- Editable on any non-`ARCHIVED` cycle (DRAFT / OPEN / CLOSED).
- Removal is allowed-with-warning: always save; surface removed departments that still have applicants. Never block removal.
- Permission `recruitment.manage_cycles` is enforced in the action (service trusts the caller, matching existing cycle-service convention).
- Tests run against the test DB. Run with: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_subc" npm test -- <file>` (this worktree shares that isolated DB; it already has all migrations and no schema change is needed here).

---

### Task 1: Service `setCycleDepartments`

**Files:**
- Modify: `src/modules/recruitment/services/cycles.ts`
- Test: `src/modules/recruitment/services/cycles.test.ts`

**Interfaces:**
- Consumes: `prisma`, `recordAudit`, `CyclePublishError` (existing in this file), `RecruitmentCycle` type.
- Produces:
  - `type RemovedDepartmentImpact = { code: string; applicantCount: number }`
  - `setCycleDepartments(id: string, departmentCodes: string[], actorId: string): Promise<{ cycle: RecruitmentCycle; removedWithApplicants: RemovedDepartmentImpact[] }>`

- [ ] **Step 1: Write the failing tests.** Append to `src/modules/recruitment/services/cycles.test.ts`:

```ts
describe("setCycleDepartments", () => {
  async function makeCycle(departments: string[]) {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: `v-${departments.join("-").toLowerCase() || "none"}`,
      departments, acceptsRenewals: false, createdById: person.id,
    });
    return { person, cycle };
  }

  it("adds a department and records the new list", async () => {
    const { person, cycle } = await makeCycle(["SRHD"]);
    const { cycle: updated, removedWithApplicants } = await setCycleDepartments(cycle.id, ["SRHD", "MDIC"], person.id);
    expect(updated.departments).toEqual(["SRHD", "MDIC"]);
    expect(removedWithApplicants).toEqual([]);
  });

  it("removes a department with no applicants without warning", async () => {
    const { person, cycle } = await makeCycle(["SRHD", "MDIC"]);
    const { cycle: updated, removedWithApplicants } = await setCycleDepartments(cycle.id, ["SRHD"], person.id);
    expect(updated.departments).toEqual(["SRHD"]);
    expect(removedWithApplicants).toEqual([]);
  });

  it("removes a department that has applicants, saving but reporting the impact", async () => {
    const { person, cycle } = await makeCycle(["SRHD", "MDIC"]);
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "A", email: "a@yale.edu", emailLower: "a@yale.edu" } });
    await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["MDIC"] } });
    const { cycle: updated, removedWithApplicants } = await setCycleDepartments(cycle.id, ["SRHD"], person.id);
    expect(updated.departments).toEqual(["SRHD"]);
    expect(removedWithApplicants).toEqual([{ code: "MDIC", applicantCount: 1 }]);
  });

  it("trims and dedupes the input", async () => {
    const { person, cycle } = await makeCycle(["SRHD"]);
    const { cycle: updated } = await setCycleDepartments(cycle.id, [" SRHD ", "SRHD", "MDIC", ""], person.id);
    expect(updated.departments).toEqual(["SRHD", "MDIC"]);
  });

  it("rejects a missing cycle", async () => {
    const { person } = await seedTermAndPerson();
    await expect(setCycleDepartments("missing", ["SRHD"], person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects an archived cycle", async () => {
    const { person, cycle } = await makeCycle(["SRHD"]);
    await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "ARCHIVED" } });
    await expect(setCycleDepartments(cycle.id, ["SRHD", "MDIC"], person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("records an audit entry with before and after departments", async () => {
    const { person, cycle } = await makeCycle(["SRHD"]);
    await setCycleDepartments(cycle.id, ["SRHD", "MDIC"], person.id);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: cycle.id, action: "recruitment.cycle_set_departments" } });
    expect(audit).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_subc" npm test -- src/modules/recruitment/services/cycles.test.ts`
Expected: the new `setCycleDepartments` tests FAIL with "setCycleDepartments is not a function" / import error; the existing cycles tests still pass.

- [ ] **Step 3: Implement the service.** In `src/modules/recruitment/services/cycles.ts`, add at the end of the file:

```ts
export type RemovedDepartmentImpact = { code: string; applicantCount: number };

/** Replace a cycle's department list (add or remove). Allowed on any non-archived
 *  cycle. Removal is never blocked: the new list is always saved, and any removed
 *  department that still has applicants is reported back so the caller can warn.
 *  Codes are trimmed, de-duplicated, and emptied entries dropped (order preserved). */
export async function setCycleDepartments(
  id: string,
  departmentCodes: string[],
  actorId: string
): Promise<{ cycle: RecruitmentCycle; removedWithApplicants: RemovedDepartmentImpact[] }> {
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id } });
  if (!cycle) throw new CyclePublishError("Cycle not found.");
  if (cycle.status === "ARCHIVED") throw new CyclePublishError("Departments cannot be changed on an archived cycle.");

  const next: string[] = [];
  for (const raw of departmentCodes) {
    const code = raw.trim();
    if (code && !next.includes(code)) next.push(code);
  }

  const removed = cycle.departments.filter((c) => !next.includes(c));
  const removedWithApplicants: RemovedDepartmentImpact[] = [];
  for (const code of removed) {
    const applicantCount = await prisma.application.count({ where: { cycleId: id, departmentChoices: { has: code } } });
    if (applicantCount > 0) removedWithApplicants.push({ code, applicantCount });
  }

  const updated = await prisma.recruitmentCycle.update({ where: { id }, data: { departments: next } });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.cycle_set_departments",
    entityType: "RecruitmentCycle",
    entityId: id,
    before: { departments: cycle.departments },
    after: { departments: next },
  });
  return { cycle: updated, removedWithApplicants };
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_subc" npm test -- src/modules/recruitment/services/cycles.test.ts`
Expected: PASS (existing cycles tests + 7 new).

- [ ] **Step 5: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/modules/recruitment/services/cycles.ts src/modules/recruitment/services/cycles.test.ts
git commit -m "feat(recruitment): setCycleDepartments service (edit departments after creation)"
```

---

### Task 2: Action + Departments card on the cycle overview page

**Files:**
- Modify: `src/app/(app)/recruitment/actions.ts`
- Modify: `src/app/(app)/recruitment/cycles/[id]/page.tsx`

**Interfaces:**
- Consumes: Task 1 `setCycleDepartments`; existing `CyclePublishError`, `requirePermission`, `getCycle`, `prisma`, UI primitives.
- Produces: `setCycleDepartmentsAction(cycleId: string, formData: FormData)`.

- [ ] **Step 1: Add the server action.** In `src/app/(app)/recruitment/actions.ts`:

Add `setCycleDepartments` to the existing import from the cycles service:
```ts
import {
  createCycle, publishCycle, closeCycle, setAcceptsRenewals, setCycleDepartments, CyclePublishError,
} from "@/modules/recruitment/services/cycles";
```

Append the action (place it near `toggleRenewalsAction`):
```ts
export async function setCycleDepartmentsAction(cycleId: string, formData: FormData) {
  const person = await requirePermission("recruitment.manage_cycles");
  const departments = formData.getAll("departments").map(String).map((d) => d.trim()).filter(Boolean);
  let warn = "";
  try {
    const { removedWithApplicants } = await setCycleDepartments(cycleId, departments, person.personId);
    if (removedWithApplicants.length > 0) {
      warn = removedWithApplicants.map((r) => `${r.code} (${r.applicantCount})`).join(", ");
    }
  } catch (err) {
    if (err instanceof CyclePublishError) {
      redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  redirect(`/recruitment/cycles/${cycleId}?${warn ? `deptwarn=${encodeURIComponent(warn)}` : "deptsaved=1"}`);
}
```

(The `redirect` is outside the try/catch so Next's `NEXT_REDIRECT` is not caught. `warn` is computed inside the try, used after.)

- [ ] **Step 2: Typecheck the action.**

Run: `npm run typecheck`
Expected: PASS (the page does not yet reference the action, but the import resolves).

- [ ] **Step 3: Add the Departments card to the cycle overview page.** In `src/app/(app)/recruitment/cycles/[id]/page.tsx`:

(a) Add imports at the top (alongside the existing imports):
```ts
import { prisma } from "@/platform/db";
import { Checkbox } from "@/platform/ui/checkbox";
import { setCycleDepartmentsAction } from "../../actions";
```

(b) Extend the `searchParams` type and destructure to include the new params. Change the `PageProps` `searchParams` type to:
```ts
  searchParams: Promise<{ error?: string; deptsaved?: string; deptwarn?: string }>;
```
and the destructure to:
```ts
  const { error, deptsaved, deptwarn } = await searchParams;
```

(c) After `const cycle = await getCycle(id); if (!cycle) notFound();`, load the active departments and per-department applicant counts:
```ts
  const activeDepts = await prisma.department.findMany({ where: { isActive: true }, select: { code: true, name: true }, orderBy: { code: "asc" } });
  const apps = await prisma.application.findMany({ where: { cycleId: id }, select: { departmentChoices: true } });
  const counts = new Map<string, number>();
  for (const a of apps) for (const c of a.departmentChoices) counts.set(c, (counts.get(c) ?? 0) + 1);
  // Option set: active departments plus any current cycle code not in the active list
  // (so deactivated / free-text codes are shown and never silently dropped).
  const activeCodes = new Set(activeDepts.map((d) => d.code));
  const deptOptions = [
    ...activeDepts.map((d) => ({ code: d.code, name: d.name, known: true })),
    ...cycle.departments.filter((c) => !activeCodes.has(c)).map((c) => ({ code: c, name: null as string | null, known: false })),
  ];
  const selected = new Set(cycle.departments);
```

(d) Add the card to the rendered JSX. Place it just after the public-link card (after the closing `</div>` of the `Public link` block, before the publish/close controls). Insert:
```tsx
      <div className="space-y-3 rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wider text-subtle-foreground">Departments</p>
        {deptsaved && <Alert tone="success">Departments updated.</Alert>}
        {deptwarn && <Alert tone="warning">Saved. These removed departments still have applicants: {deptwarn}. Existing applications keep their choices, but you can no longer accept into a removed department.</Alert>}
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
          <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save departments</SubmitButton>
        </form>
      </div>
```

- [ ] **Step 4: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Build.**

Run: `npm run build`
Expected: build succeeds (the cycle overview route compiles).

- [ ] **Step 6: Manual verification.**

Run `npm run dev`. Open a cycle's overview page. Confirm the Departments card lists active departments (checked for the cycle's current ones) with applicant counts. Check a new department, save, and confirm the success alert and that it persists. Uncheck a department that has an applicant (create one first via the public form or DB) and confirm the warning alert names it. Confirm it also works on a CLOSED cycle (close the cycle first).
Expected: edits persist; warning shows for removed departments with applicants; works in DRAFT/OPEN/CLOSED.

- [ ] **Step 7: Commit.**

```bash
git add "src/app/(app)/recruitment/actions.ts" "src/app/(app)/recruitment/cycles/[id]/page.tsx"
git commit -m "feat(recruitment): edit cycle departments from the overview page"
```

---

## Self-Review notes (coverage map)

- Spec §1 service `setCycleDepartments` (normalize, removed-impact, archived guard, audit) -> Task 1.
- Spec §2 action `setCycleDepartmentsAction` (getAll, warn/saved redirect, NEXT_REDIRECT-safe) -> Task 2 Step 1.
- Spec §3 UI card (multi-select of active depts UNION current codes, applicant counts inline, success/warning alerts, placed on overview) -> Task 2 Steps 3.
- Spec testing (add / remove-clean / remove-with-applicants / dedupe-trim / missing + archived / audit) -> Task 1 Step 1.
- No migration (departments is existing column) -> confirmed, no task needed.
