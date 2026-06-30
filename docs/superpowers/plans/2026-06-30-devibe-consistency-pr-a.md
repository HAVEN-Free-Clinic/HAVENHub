# De-vibecode / Consistency Hardening, PR A (substantive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the substantive "machine-generated" fingerprints from the codebase: extract duplicated helpers, fix the RBAC inverse-resolver divergence, sweep all em-dashes and enforce their absence with a lint rule, and normalize copy inconsistencies.

**Architecture:** Per-file duplicated helpers (`cx`, `fmtDate`/`fmtDateTime`, `getActiveTerm`, the P2002 check, the action try/catch skeleton) are consolidated onto a single canonical version each, with every refactor output-equivalent (existing tests stay green). The RBAC fix deletes a redundant pre-#158 fold-in so the inverse resolver matches the forward one. A small custom ESLint rule bans the em-dash character across `src`, driving and gating the sweep.

**Tech Stack:** Next.js App Router (React Server/Client Components), TypeScript, Tailwind, Prisma, Vitest (environment node), ESLint flat config (eslint.config.mjs extending eslint-config-next).

## Global Constraints

- No em-dashes (the `—` character) anywhere, including comments. Use commas, colons, semicolons, parentheses, or a plain hyphen.
- Product name is "HAVEN Hub" (two words) in prose and UI; identifiers stay `havenhub`.
- Every refactor in this plan is output-equivalent: existing tests stay green and visible output (rendered class strings, formatted dates, page copy) is unchanged except where Task 8 specifies a copy fix.
- This repo has no tailwind-merge; never rely on a className override of a primitive's conflicting base class.
- Do not run `prisma generate` in the worktree (shared cross-worktree client; CI regenerates). Local `tsc` may show pre-existing stale-client errors; "clean" means no new errors in changed files.
- Tests use Vitest. Run a single file with `npx vitest run <path>`; run lint with `npm run lint`; typecheck with `npx tsc --noEmit`.
- Branch: `feat/devibe-consistency` (already created off main). Commit after each task.

---

### Task 1: Extract the `cx` classname helper

**Files:**
- Create: `src/platform/ui/cx.ts`
- Modify: `src/platform/ui/button.tsx` (remove local `cx` at lines 22-24, import it)
- Modify (remove local `cx`, add import): `src/platform/ui/card.tsx`, `radio.tsx`, `alert.tsx`, `combobox.tsx`, `section-header.tsx`, `table.tsx`, `checkbox.tsx`, `badge.tsx`, `select.tsx`, `input.tsx`, `stat-card.tsx`, `form.tsx`, and `src/modules/recruitment/components/field-preview.tsx`
- Modify (repoint import source): `src/platform/ui/skeleton.tsx:1`, `src/platform/ui/spinner.tsx:1` (currently `import { cx } from "./button"`)

**Interfaces:**
- Produces: `export function cx(...parts: (string | undefined | false | null)[]): string` in `@/platform/ui/cx`.

- [ ] **Step 1: Create the canonical module**

```ts
// src/platform/ui/cx.ts
/** Join truthy class-name parts with a space. The one canonical classname helper. */
export function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}
```

- [ ] **Step 2: Repoint `button.tsx`**

Delete the `cx` function (button.tsx:22-24) and add at the top of the file (with the other imports):

```ts
import { cx } from "./cx";
```

`buttonClasses` keeps using `cx` unchanged.

- [ ] **Step 3: Repoint the other 12 platform/ui files and field-preview**

In each of `card.tsx`, `radio.tsx`, `alert.tsx`, `combobox.tsx`, `section-header.tsx`, `table.tsx`, `checkbox.tsx`, `badge.tsx`, `select.tsx`, `input.tsx`, `stat-card.tsx`, `form.tsx`: delete the local `cx` definition and add `import { cx } from "./cx";` (alongside existing imports). In `src/modules/recruitment/components/field-preview.tsx`: delete its local `cx` and add `import { cx } from "@/platform/ui/cx";`.

- [ ] **Step 4: Repoint skeleton and spinner**

In `skeleton.tsx:1` and `spinner.tsx:1` change `from "./button"` to `from "./cx"`.

- [ ] **Step 5: Verify exactly one definition remains**

Run: `rg -c 'function cx' src` (expect a single hit, in `src/platform/ui/cx.ts`). Then `rg -n "import \{[^}]*\bcx\b" src | rg -v 'ui/cx'` should return nothing (no importer still points elsewhere).

- [ ] **Step 6: Typecheck, lint, and run UI tests**

Run: `npx tsc --noEmit` (no new errors), `npm run lint` (clean), and `npx vitest run src/platform/ui` (existing primitive tests pass; class strings unchanged because `cx` is byte-identical).

- [ ] **Step 7: Commit**

```bash
git add src/platform/ui src/modules/recruitment/components/field-preview.tsx
git commit -m "refactor(ui): one canonical cx helper, drop 14 re-pasted copies"
```

---

### Task 2: Consolidate display date formatters

**Files:**
- Modify: `src/platform/dates.ts` (add `fmtDate`, `fmtDateTime`; fix the en-dash in the line 18 comment)
- Test: `src/platform/dates.test.ts` (create or extend)
- Modify (repoint to shared `fmtDate`): `src/app/(app)/schedule/page.tsx:30`, `src/app/(app)/volunteers/page.tsx:57`, and the same-format `fmtDate` in `volunteers/offboarding/page.tsx`, `volunteers/master/page.tsx`, `volunteers/epic/page.tsx`, `volunteers/disciplinary/page.tsx`
- Modify (repoint to existing `isoDateKey`): `src/app/(app)/admin/email/campaigns/page.tsx:8`
- Modify (repoint to shared `fmtDateTime`): `src/app/(app)/admin/email/page.tsx:57`, `src/app/(app)/admin/notifications/page.tsx:46`, `src/app/(app)/notifications/page.tsx:16`
- Leave local (distinct format, do not merge): `src/app/(app)/training/page.tsx:30` (`fmtDate` with no year)

**Interfaces:**
- Consumes: `isoDateKey(d: Date): string` (already in dates.ts).
- Produces: `fmtDate(d: Date | null | undefined, fallback?: string): string` and `fmtDateTime(d: Date | null | undefined, fallback?: string): string` in `@/platform/dates`.

**Background:** the `fmtDate` copies use three different formats. The dominant cluster (`volunteers/*` x5 plus `schedule/page.tsx`) is `toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })` with null rendered as `"-"`. `admin/email/campaigns/page.tsx` uses a manual `YYYY-MM-DD`, which is exactly `isoDateKey`. `training/page.tsx` uses a no-year `{ month: "short", day: "numeric", timeZone: "UTC" }` and stays local. The `fmtDateTime` copies share a manual UTC `YYYY-MM-DD HH:MM` with null rendered as `"-"`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/platform/dates.test.ts  (add these; keep any existing cases)
import { describe, expect, it } from "vitest";
import { fmtDate, fmtDateTime } from "./dates";

describe("fmtDate", () => {
  it("formats a UTC date as 'Mon D, YYYY'", () => {
    expect(fmtDate(new Date("2026-06-13T12:00:00Z"))).toBe("Jun 13, 2026");
  });
  it("renders the fallback for null/undefined", () => {
    expect(fmtDate(null)).toBe("-");
    expect(fmtDate(undefined)).toBe("-");
    expect(fmtDate(null, "None")).toBe("None");
  });
});

describe("fmtDateTime", () => {
  it("formats a UTC date-time as 'YYYY-MM-DD HH:MM'", () => {
    expect(fmtDateTime(new Date("2026-06-13T09:05:00Z"))).toBe("2026-06-13 09:05");
  });
  it("renders the fallback for null", () => {
    expect(fmtDateTime(null)).toBe("-");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/platform/dates.test.ts`
Expected: FAIL (fmtDate/fmtDateTime not exported).

- [ ] **Step 3: Implement the formatters in dates.ts**

Add to `src/platform/dates.ts`:

```ts
/** "Jun 13, 2026" in UTC. Null/undefined render as `fallback` (default "-"). */
export function fmtDate(d: Date | null | undefined, fallback = "-"): string {
  if (!d) return fallback;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "2026-06-13 09:05" in UTC. Null/undefined render as `fallback` (default "-"). */
export function fmtDateTime(d: Date | null | undefined, fallback = "-"): string {
  if (!d) return fallback;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())}`;
}
```

Also fix the comment on `dates.ts:18`: change `Mon–Fri` to `Monday to Friday`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/platform/dates.test.ts`
Expected: PASS.

- [ ] **Step 5: Repoint the call sites**

For each dominant-cluster file (`schedule/page.tsx` and the five `volunteers/*` pages), delete the local `fmtDate` and add `import { fmtDate } from "@/platform/dates";`. Before deleting, confirm the local body matches the shared format exactly (year, month short, day, UTC, null to "-"); if a copy differs, leave it local and note it in the report. In `admin/email/campaigns/page.tsx`, delete the local `fmtDate` and replace its uses with `isoDateKey` (`import { isoDateKey } from "@/platform/dates"`), since its body is the same `YYYY-MM-DD`. For the three `fmtDateTime` files, delete the local and add `import { fmtDateTime } from "@/platform/dates";` (the `notifications/page.tsx` copy takes a non-null `Date`; the shared nullable signature is compatible). Leave `training/page.tsx` `fmtDate` untouched (distinct no-year format).

- [ ] **Step 6: Typecheck and test**

Run: `npx tsc --noEmit` and `npx vitest run src/platform/dates.test.ts`. Confirm no call site changed visible output.

- [ ] **Step 7: Commit**

```bash
git add src/platform/dates.ts src/platform/dates.test.ts "src/app/(app)"
git commit -m "refactor(dates): shared fmtDate/fmtDateTime, drop duplicated formatters"
```

---

### Task 3: Use the canonical `getActiveTerm`

**Files:**
- Modify (delete local `getActiveTerm`, import canonical): `src/modules/schedule/services/builder.ts:81`, `src/modules/schedule/services/requests.ts:72`, `src/modules/volunteers/services/disciplinary.ts:93`, `src/modules/volunteers/services/offboarding.ts:83`
- Review only (repoint inlined `findFirst({ where: { status: "ACTIVE" } })` if and only if exactly equivalent): `src/modules/volunteers/services/compliance.ts:92` and any others a grep surfaces

**Interfaces:**
- Consumes: `getActiveTerm(): Promise<Term | null>` from `@/platform/terms/active-term` (request-memoized via React `cache()`; `findFirst` where status ACTIVE, `orderBy startDate desc`).

- [ ] **Step 1: Replace the four local redefinitions**

In each of the four service files, delete the local `getActiveTerm` definition and add `import { getActiveTerm } from "@/platform/terms/active-term";`. Confirm each local body is `findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } })` (the canonical shape) before deleting; if one selects differently, leave it and note it.

- [ ] **Step 2: Repoint exact-equivalent inlines**

Run: `rg -n 'status: "ACTIVE"' src/modules src/platform -g '*.ts'` and inspect each. For any that is exactly `prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } })` assigned to an active-term variable, replace with `getActiveTerm()`. Leave any that omit the `orderBy` or select different fields (not output-equivalent) and note them in the report. Do not change queries that find memberships or non-term rows by ACTIVE status.

- [ ] **Step 3: Typecheck and run the affected service tests**

Run: `npx tsc --noEmit`, then `npx vitest run src/modules/schedule src/modules/volunteers`.
Expected: PASS (behavior identical; the canonical version adds request-level caching, which only reduces query count).

- [ ] **Step 4: Commit**

```bash
git add src/modules
git commit -m "refactor(terms): use canonical cached getActiveTerm, drop local copies"
```

---

### Task 4: Shared `isUniqueConstraintError` guard

**Files:**
- Modify: `src/platform/db.ts` (add the guard)
- Test: `src/platform/db.test.ts` (create)
- Modify (replace P2002 idioms): `src/modules/recruitment/services/interviews.ts:41,134`, `submissions.ts:272`, `review.ts:83`, `departments.ts:91` (verbose form); `requests.ts:329`, `src/modules/admin/services/rbac.ts:137,200`, `src/platform/airtable/import/importer.ts:117` (instanceof form); `src/modules/admin/services/terms.ts:155`, `people.ts:44` (loose-cast form)

**Interfaces:**
- Produces: `isUniqueConstraintError(err: unknown): err is Prisma.PrismaClientKnownRequestError` in `@/platform/db`.

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/db.test.ts
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { isUniqueConstraintError } from "./db";

describe("isUniqueConstraintError", () => {
  it("is true for a P2002 known-request error", () => {
    const err = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
    expect(isUniqueConstraintError(err)).toBe(true);
  });
  it("is false for another Prisma code and for a plain error", () => {
    const other = new Prisma.PrismaClientKnownRequestError("nf", { code: "P2025", clientVersion: "x" });
    expect(isUniqueConstraintError(other)).toBe(false);
    expect(isUniqueConstraintError(new Error("nope"))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/platform/db.test.ts`
Expected: FAIL (isUniqueConstraintError not exported).

- [ ] **Step 3: Add the guard to db.ts**

Change the import line and add the guard:

```ts
import { Prisma, PrismaClient } from "@prisma/client";

// ... existing prisma singleton unchanged ...

/** True when `err` is a Prisma unique-constraint (P2002) violation. */
export function isUniqueConstraintError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/platform/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Replace the idioms at every call site**

At each listed site, replace the inline check with `isUniqueConstraintError(err)` (import from `@/platform/db`). A site that then reads `err.meta?.target` keeps that line (the guard narrows `err` to `Prisma.PrismaClientKnownRequestError`, so `.meta` is typed). Verify completeness: `rg -n '"code" in err|code === "P2002"' src` should return nothing afterward except inside `db.ts`.

- [ ] **Step 6: Typecheck and run affected tests**

Run: `npx tsc --noEmit`, then `npx vitest run src/modules/recruitment src/modules/admin src/platform/airtable`.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/platform/db.ts src/platform/db.test.ts src/modules src/platform/airtable
git commit -m "refactor(db): one typed isUniqueConstraintError guard for P2002"
```

---

### Task 5: Smaller dedup (escape, settings, dead exports)

**Files:**
- Modify: `src/platform/notifications/render.ts` (drop local `escapeHtml`, import `esc`)
- Modify: `src/platform/settings/service.ts` (extract a local `resolveStored`)
- Modify/delete (only where zero non-test callers): `src/platform/airtable/client.ts` (`escapeFormulaString` + unused `filterByFormula` param), `src/modules/schedule/services/attendings.ts` (`setAttendingActive`), `src/modules/recruitment/services/submissions.ts` (`listApplications`), `src/modules/recruitment/services/portal-status.ts` (`listApplicantApplications`), `src/modules/recruitment/services/evaluations.ts` (`listEvaluations`), `src/modules/my-info/services/my-info.ts` (`getOwnedCertificate`)

**Interfaces:**
- Consumes: `esc(value: string): string` from `@/platform/email/render/escape` (byte-identical to the local `escapeHtml`).

- [ ] **Step 1: Replace `escapeHtml` with `esc`**

In `render.ts`, delete the local `escapeHtml` (lines 4-11) and add `import { esc } from "@/platform/email/render/escape";`, then replace the three `escapeHtml(` calls in `renderTeamsBody` with `esc(`.

- [ ] **Step 2: Extract `resolveStored` in settings/service.ts**

Add a file-local helper that captures the safeParse-warn-default block, and call it from both `getSetting` and `getCategory`:

```ts
/** Parse a stored raw value against the def schema; warn and fall back on failure. */
function resolveStored(def: SettingDef, raw: unknown): unknown {
  const parsed = def.schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn(`[settings] invalid stored value for "${def.key}"; using default`, parsed.error.issues);
  return def.envDefault();
}
```

In `getSetting`, replace the `if (row) { ... } else { value = def.envDefault(); }` block so the row branch uses `value = resolveStored(def, row.value)`. In `getCategory`, replace the override safeParse block: when `overrides.has(def.key)`, set `value = resolveStored(def, overrides.get(def.key))` and `isOverridden` stays true only on a successful parse. Preserve the exact `isOverridden` semantics: it is true only when the override parsed successfully. To keep that, have `resolveStored` not signal success; instead inline the success check in `getCategory` using `def.schema.safeParse` once, or return a small `{ value, ok }`. Use this shape:

```ts
function resolveStored(def: SettingDef, raw: unknown): { value: unknown; ok: boolean } {
  const parsed = def.schema.safeParse(raw);
  if (parsed.success) return { value: parsed.data, ok: true };
  console.warn(`[settings] invalid stored value for "${def.key}"; using default`, parsed.error.issues);
  return { value: def.envDefault(), ok: false };
}
```

`getSetting`: `value = row ? resolveStored(def, row.value).value : def.envDefault()`. `getCategory`: `const r = resolveStored(def, overrides.get(def.key)); value = r.value; isOverridden = r.ok;`. Use the real `SettingDef` type name from the file (read the imports; if the def type is not exported, type the param as the element type of `SETTINGS`).

- [ ] **Step 3: Remove genuinely dead exports (grep-gated)**

For each candidate, run `rg -n '\b<name>\b' src --type ts | rg -v '\.test\.'` (and a check of non-test importers). If there are zero non-test references, delete the function and its now-orphaned test cases; if it is referenced, leave it untouched and note that in the report. For `airtable/client.ts`, also remove the `filterByFormula` parameter only if no caller passes it. For `setAttendingActive`: if a page passes `isActive` to `updateAttending`, delete `setAttendingActive`; otherwise leave it.

- [ ] **Step 4: Typecheck, lint, and test**

Run: `npx tsc --noEmit`, `npm run lint`, then `npx vitest run src/platform/settings src/platform/notifications` plus any module whose dead export (and its test) you removed.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform src/modules
git commit -m "refactor: reuse esc, extract settings resolveStored, drop dead exports"
```

---

### Task 6: Fix the RBAC inverse-resolver divergence

**Files:**
- Modify: `src/platform/rbac/holders.ts` (delete `AUTO_ROLE_KIND` and the fold-in loop; update docstring)
- Modify: `src/platform/rbac/system-roles.ts` (fix the stale comment, lines 3-5)
- Test: `src/platform/rbac/holders.test.ts` (add the regression test; update any test that asserts the old behavior)

**Interfaces:**
- `peopleWithAnyPermission(permissions: string[]): Promise<PermissionHolder[]>` is unchanged in signature; only its kind-derivation changes (it stops auto-folding Director/Volunteer from membership kind, deriving kinds only from matched `RoleAssignment` rows).

**Background:** post-#158, baseline Director/Volunteer access is provisioned as kind-target `RoleAssignment` rows; `engine.ts` (forward resolver) has no kind auto-attach. `holders.ts` still folds kinds in from system-role name via `AUTO_ROLE_KIND`, so the inverse resolver over-reports once kind-target wiring is edited. Use `engine.test.ts`'s `fixture()` and `resetDb` from `@/platform/test/db` as the seeding pattern.

- [ ] **Step 1: Write the failing regression test**

Add to `src/platform/rbac/holders.test.ts` a test that proves the inverse resolver depends on the kind-target assignment (not membership kind alone):

```ts
it("does not report a DIRECTOR member once the kind-target assignment is removed", async () => {
  await resetDb();
  const term = await prisma.term.create({
    data: { code: "SU26", name: "Summer 2026", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" },
  });
  const dir = await prisma.role.create({
    data: { name: "Director", isSystem: true, grants: { create: [{ permission: "volunteers.review" }] } },
  });
  const person = await prisma.person.create({ data: { name: "Dana Director", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { termId: term.id, personId: person.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const assignment = await prisma.roleAssignment.create({ data: { roleId: dir.id, kind: "DIRECTOR", termId: null } });

  // With the kind-target assignment present, Dana holds the permission.
  expect((await peopleWithAnyPermission(["volunteers.review"])).map((p) => p.id)).toContain(person.id);

  // Remove the wiring (as the roles page can). Forward resolver would no longer grant it;
  // the inverse resolver must agree and stop reporting Dana.
  await prisma.roleAssignment.delete({ where: { id: assignment.id } });
  expect((await peopleWithAnyPermission(["volunteers.review"])).map((p) => p.id)).not.toContain(person.id);
});
```

Use the exact `Person`/`TermMembership`/`RoleAssignment` field names the schema requires (read `prisma/schema.prisma` and mirror `engine.test.ts`; add `contactEmail`/`entraObjectId` if non-nullable). Import `peopleWithAnyPermission`, `prisma`, and `resetDb` at the top to match the file's existing imports.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/platform/rbac/holders.test.ts`
Expected: the new test FAILS at the second assertion (current code auto-folds DIRECTOR via `AUTO_ROLE_KIND`, so Dana is still reported after the assignment is removed).

- [ ] **Step 3: Delete the fold-in**

In `holders.ts`, delete the `AUTO_ROLE_KIND` map (lines 18-21) and the fold-in loop (lines 64-68, the `for (const r of roles) { if (r.isSystem && AUTO_ROLE_KIND[r.name]) ... }`). Update the docstring (lines 23-33) to remove the "plus the auto-attached Director/Volunteer baselines" clause and state that kinds derive from the matched assignments only, matching `getEffectivePermissions`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/platform/rbac/holders.test.ts`
Expected: PASS. If any pre-existing test in the file fails, inspect it: a test that seeded a kind member WITHOUT a kind-target assignment and expected them returned was asserting the old (buggy) behavior; update it to seed the kind-target assignment (matching the decouple and `engine.test.ts`). Do not weaken the new regression test.

- [ ] **Step 5: Fix the stale comment in system-roles.ts**

Replace lines 3-5 (the "auto-attached by the RBAC engine from TermMembership.kind (see engine.ts MEMBERSHIP_KIND_ROLE)" sentence) with the post-#158 truth:

```
 * dev seed (prisma/seed.ts) and the production backfill migrations. Baseline
 * Director/Volunteer access is provisioned as kind-target RoleAssignment rows
 * (seed plus backfill migration), not auto-attached in code; the rest are
 * assigned explicitly.
```

- [ ] **Step 6: Typecheck and run the full rbac suite**

Run: `npx tsc --noEmit`, then `npx vitest run src/platform/rbac`.
Expected: PASS (engine, holders, schema-guards, system-roles, director-learning-access).

- [ ] **Step 7: Commit**

```bash
git add src/platform/rbac
git commit -m "fix(rbac): inverse resolver no longer auto-folds kind baselines (#post-158)"
```

---

### Task 7: Em-dash ESLint rule plus full sweep

**Files:**
- Modify: `eslint.config.mjs` (add the custom rule)
- Modify: every `src` file flagged by the rule (about 31 in non-test code plus any in tests), including `dates.ts` already handled in Task 2

**Interfaces:**
- Produces a flat-config block registering `local/no-em-dash` as an error across `src/**/*.{ts,tsx}`.

- [ ] **Step 1: Add the custom rule to eslint.config.mjs**

Above `const eslintConfig = [`, define the rule (note: the literal below contains the em-dash character only inside the rule's own string scanner and message; that file is not linted by the rule, which is scoped to `src`):

```js
const noEmDash = {
  meta: { type: "problem", docs: { description: "Ban the em-dash character; it reads as AI-generated." }, schema: [] },
  create(context) {
    const src = context.sourceCode;
    return {
      Program(node) {
        const text = src.getText();
        const DASH = "—";
        for (let i = text.indexOf(DASH); i !== -1; i = text.indexOf(DASH, i + 1)) {
          context.report({
            node,
            loc: src.getLocFromIndex(i),
            message:
              "Em-dash reads as AI-generated; use a comma, colon, parentheses, or hyphen. Add an eslint-disable-next-line local/no-em-dash with a reason if genuinely required.",
          });
        }
      },
    };
  },
};
```

Then add a new block to the `eslintConfig` array (after the controls `no-restricted-syntax` block):

```js
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { local: { rules: { "no-em-dash": noEmDash } } },
    rules: { "local/no-em-dash": "error" },
  },
```

- [ ] **Step 2: Negative check (rule fires)**

Temporarily add a line `// test — dash` (with a literal em-dash) to any `src/**/*.ts` file, run `npm run lint`, confirm it reports `local/no-em-dash` at that line, then remove the line.

- [ ] **Step 3: Get the authoritative list and sweep**

Run `npm run lint` (it now lists every em-dash). Replace each, choosing the punctuation that reads best (comma, colon, semicolon, parentheses, or hyphen). User-facing replacements are fixed:
- `src/modules/admin/components/epic-request-form.tsx:381` placeholder becomes `Choose a department` (drop the wrapping dashes).
- `epic-request-form.tsx:328,384` `{code} — {name}` separator becomes `{code}: {name}` (a colon).
- `src/app/(app)/training/training-quiz.tsx:100` becomes a period or colon at the break.
- `training-quiz.tsx:183` becomes `All questions answered. Ready to submit.`
- `src/app/(app)/schedule/page.tsx:223` becomes a comma.
- `schedule/page.tsx:364,370` the `"—"` empty-value glyph becomes `"-"`.
- `src/app/(app)/admin/itcm/page.tsx:57` becomes a period before `follow up`.
- `src/app/(app)/admin/email/campaigns/[id]/page.tsx:245,247` become `Scheduled. Waiting to send.` and `Recurring. Sends on a schedule.`

Comment em-dashes (the bulk, concentrated in `modules/admin/services/itcm-pdf.ts` and `app/api/admin/itcm/generate/route.ts`, plus singles elsewhere) become commas, colons, semicolons, or parentheses. Sweep test files too so lint is globally green.

- [ ] **Step 4: Verify the sweep is complete**

Run: `npm run lint` (green: zero `local/no-em-dash`). Also `rg -c '—' src` returns nothing. `npx tsc --noEmit` shows no new errors.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs src
git commit -m "feat(lint): ban em-dash via custom rule; sweep all occurrences"
```

---

### Task 8: Copy consistency

**Files (all Modify):**
- `src/app/(app)/volunteers/master/page.tsx:172,173`, `volunteers/epic/page.tsx:381,382`, `volunteers/disciplinary/page.tsx:265,266`, `volunteers/page.tsx:138,156`, `volunteers/offboarding/page.tsx:114`, `src/app/(app)/admin/audit/page.tsx:41`
- `src/app/onboard/[token]/onboard-form.tsx:126,129,133,137`, `src/platform/email/templates/recruitment.ts:70`
- `src/modules/clinic/avs/avs-tool.tsx:173,214`, `src/app/(app)/learning/[courseId]/ScormPlayer.tsx:139`
- `src/app/(app)/training/page.tsx:190,266`, `src/app/not-found.tsx:27`, `src/app/(app)/page.tsx:232`
- `src/modules/admin/services/email/.../compliance.ts:181,231,249`, `epic.ts:154,180` (descriptor names)

- [ ] **Step 1: Sentence-case the four Title Case headers**

`volunteers/master/page.tsx:172` to `Master compliance view`; `volunteers/epic/page.tsx:381` to `Epic requests`; `volunteers/disciplinary/page.tsx:265` to `Disciplinary actions`; `admin/audit/page.tsx:41` to `Audit log`. Change only the visible header string; leave route names and identifiers.

- [ ] **Step 2: Normalize `EPIC` to `Epic` on the onboarding form and email**

In `onboard-form.tsx:126,129,133,137` change user-facing `EPIC` to `Epic` (for example `Epic access`, `I already have an Epic ID`, `Existing Epic ID`). In `recruitment.ts:70` change `EPIC access details` to `Epic access details`. Run `rg -n '\bEPIC\b' src` and fix any other all-caps `EPIC` in user-facing copy; leave any genuine acronym use in code identifiers.

- [ ] **Step 3: Add trailing periods to volunteers descriptions**

Add a trailing period to the PageHeader description strings at `volunteers/page.tsx:138,156`, `volunteers/offboarding/page.tsx:114`, `volunteers/master/page.tsx:173`, `volunteers/epic/page.tsx:382`, `volunteers/disciplinary/page.tsx:266`, matching every other module.

- [ ] **Step 4: Replace raw glyphs with Lucide icons**

In `avs-tool.tsx:173,214` replace the `✕` button content with `<X className="h-4 w-4" />` (`import { X } from "lucide-react"`), keeping the existing `aria-label`. In `ScormPlayer.tsx:139` replace `{done ? "✓" : i + 1}` with `{done ? <Check className="h-4 w-4" /> : i + 1}` (`import { Check } from "lucide-react"`). Match the icon size to the surrounding layout. Confirm whether `src/modules/schedule/components/builder-cell.tsx` renders a `✕` as button content (not only in a comment); if so, convert it the same way, else leave its comment text.

- [ ] **Step 5: Align repeated labels and reword one phrase**

`training/page.tsx:190` `What this unlocks` becomes `What you can do now`. `training/page.tsx:266` and `not-found.tsx:27` both become `Back to Hub`. `page.tsx:232` quick-action `My info` becomes `My Info` (matching the registry and module name).

- [ ] **Step 6: Normalize admin email descriptor names**

In `compliance.ts:181,231,249` and `epic.ts:154,180`, change the Title Case descriptor names to the `Category: detail` form already used by `recruitment.ts` (for example `Compliance Reminder` becomes `Compliance: reminder`, `Epic Onboarding` becomes `Epic: onboarding`). These are the admin-facing template list labels; leave the template keys and any identifiers unchanged.

- [ ] **Step 7: Typecheck, lint, test**

Run: `npx tsc --noEmit`, `npm run lint` (still green, including no new em-dash), and `npx vitest run src/modules/admin src/modules/recruitment` (descriptor and template tests, if any, still pass; update a snapshot only if it asserts the old label and the new label is correct).

- [ ] **Step 8: Commit**

```bash
git add src
git commit -m "fix(ui): copy consistency (sentence-case headers, Epic casing, periods, icons, labels)"
```

---

### Task 9: `withActionRedirect` wrapper (highest risk, convert only clean fits)

**Files:**
- Create: `src/platform/actions.ts`
- Test: `src/platform/actions.test.ts`
- Modify (convert the actions that share the canonical shape): `src/app/(app)/recruitment/actions.ts`, `src/app/(app)/schedule/builder/page.tsx`

**Interfaces:**
- Produces: `runAction(opts: { work: () => Promise<void>; domainErrors: Array<new (...a: any[]) => Error>; errorRedirect: (message: string) => string; revalidate?: string }): Promise<void>` in `@/platform/actions`.

**Background:** the canonical action shape is: try a service call, on a named domain error `redirect` to an error href, re-throw anything else (so Next's `redirect` sentinel propagates), then `revalidatePath`. Actions with pre-validation, conditional success redirects, or multiple distinct catch arms do not fit and stay as-is.

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/actions.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => { const e: any = new Error("NEXT_REDIRECT"); e.digest = `NEXT_REDIRECT;${url}`; throw e; },
}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { runAction } from "./actions";
class DomainError extends Error {}

describe("runAction", () => {
  it("revalidates on success", async () => {
    revalidatePath.mockClear();
    await runAction({ work: async () => {}, domainErrors: [DomainError], errorRedirect: () => "/e", revalidate: "/p" });
    expect(revalidatePath).toHaveBeenCalledWith("/p");
  });
  it("redirects on a named domain error", async () => {
    await expect(runAction({
      work: async () => { throw new DomainError("bad"); },
      domainErrors: [DomainError], errorRedirect: (m) => `/e?m=${m}`,
    })).rejects.toMatchObject({ digest: "NEXT_REDIRECT;/e?m=bad" });
  });
  it("propagates a Next redirect sentinel untouched", async () => {
    const sentinel: any = new Error("NEXT_REDIRECT"); sentinel.digest = "NEXT_REDIRECT;/x";
    await expect(runAction({
      work: async () => { throw sentinel; }, domainErrors: [DomainError], errorRedirect: () => "/e",
    })).rejects.toBe(sentinel);
  });
  it("propagates an unknown error", async () => {
    const boom = new Error("boom");
    await expect(runAction({
      work: async () => { throw boom; }, domainErrors: [DomainError], errorRedirect: () => "/e",
    })).rejects.toBe(boom);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/platform/actions.test.ts`
Expected: FAIL (runAction not exported).

- [ ] **Step 3: Implement the wrapper**

```ts
// src/platform/actions.ts
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

type ErrorClass = new (...args: any[]) => Error;

/**
 * Run a server-action body with the common error-to-redirect shape:
 * run work(); if it throws one of domainErrors, redirect to errorRedirect(message);
 * any other throw (including Next's redirect sentinel) propagates unchanged.
 * On success, revalidate the given path when provided.
 */
export async function runAction(opts: {
  work: () => Promise<void>;
  domainErrors: ErrorClass[];
  errorRedirect: (message: string) => string;
  revalidate?: string;
}): Promise<void> {
  try {
    await opts.work();
  } catch (err) {
    if (opts.domainErrors.some((E) => err instanceof E)) {
      redirect(opts.errorRedirect((err as Error).message));
    }
    throw err;
  }
  if (opts.revalidate) revalidatePath(opts.revalidate);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/platform/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Convert the actions that fit**

In `recruitment/actions.ts`, convert the actions whose body is exactly try-service / catch-one-error-class-redirect / revalidate: `publishCycleAction`, `closeCycleAction`, `reopenCycleAction`, `archiveCycleAction`, `toggleRenewalsAction`, `updateQuizSettingsAction`, and `setTrainingCycleAction` (whose two error classes both map to the same error redirect: pass `domainErrors: [TrainingStateError, RecruitmentAuthError]`). Example conversion:

```ts
export async function publishCycleAction(cycleId: string) {
  const person = await requirePermission("recruitment.manage_cycles");
  await runAction({
    work: () => publishCycle(cycleId, person.personId),
    domainErrors: [CyclePublishError],
    errorRedirect: (m) => `/recruitment/cycles/${cycleId}?error=${encodeURIComponent(m)}`,
    revalidate: `/recruitment/cycles/${cycleId}`,
  });
}
```

Leave `createCycleAction` (different shape, success redirect), `setCycleDepartmentsAction` (warn logic and conditional success redirect), and `setApplicationWindowAction` (pre-validation and success redirect) as-is. For `schedule/builder/page.tsx`, read its inline actions and convert only those matching the canonical shape; leave any with pre-validation, conditional redirects, or multiple distinct catch arms, and note each left action with its reason in the report. Do not force a non-fitting action through the wrapper.

- [ ] **Step 6: Typecheck and test**

Run: `npx tsc --noEmit`, `npx vitest run src/platform/actions.test.ts`, and `npx vitest run src/modules/recruitment src/modules/schedule` (service behavior unchanged). Manually confirm each converted action still maps the same error class to the same href and revalidates the same path.

- [ ] **Step 7: Commit**

```bash
git add src/platform/actions.ts src/platform/actions.test.ts "src/app/(app)/recruitment/actions.ts" "src/app/(app)/schedule/builder/page.tsx"
git commit -m "refactor(actions): shared runAction wrapper for the common redirect shape"
```

---

## Final verification (whole branch)

- `npm run lint` green (new em-dash rule and controls rule both pass).
- `npx tsc --noEmit` shows no new errors in changed files (pre-existing stale-client noise excluded).
- Full test suite green: `npx vitest run` (new tests for dates, db guard, actions, RBAC regression, plus all existing tests, proving the refactors are output-equivalent).
- Spot-check that no rendered output changed: `cx` is byte-identical; `fmtDate`/`fmtDateTime` reproduce the prior format; converted actions map the same errors and revalidate the same paths.

## Self-review notes (coverage check)

- Spec workstream A: Tasks 1-5 and 9 (cx, dates, getActiveTerm, db guard, small dedup, action wrapper).
- Spec workstream B: Task 6 (RBAC fix plus regression test).
- Spec workstream C: Task 7 (custom em-dash rule plus sweep, including the dates.ts en-dash from Task 2).
- Spec workstream D: Task 8 (copy consistency).
- PR B (workstream E, cosmetic) is a separate plan, written after PR A merges or is stacked.
