# Per-Person Blocker Gate Exemption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin exempt one person from the content blocker gate, so someone on a managed device who genuinely cannot comply is not locked out, without removing the gate from everyone else.

**Architecture:** A defaulted boolean column on `Person`, carried to the `(app)` layout on the existing `PersonSession` payload (no extra query), and consumed by one named predicate that owns the whole mount rule. The admin sets it with a checkbox on the person edit page, and the existing `updatePersonFields` diff makes it audited for free.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Prisma/Postgres, Vitest.

Spec: `docs/superpowers/specs/2026-08-12-blocker-gate-person-exemption-design.md`

## Global Constraints

- **No em-dash (U+2014) anywhere in `src/**/*.{ts,tsx}`.** CI-enforced via `local/no-em-dash`. Use a comma, colon, parentheses, or hyphen.
- **No `tailwind-merge`.** Use `cx` from `@/platform/ui/cx`.
- **DOM tests** need `// @vitest-environment jsdom` on line 1, bare `createRoot` + `act()`, and must NOT use `@testing-library/react` (not a dependency).
- **Exact admin copy**, from the spec, do not paraphrase:
  - Label: `Skip the content blocker check`
  - Help: `This person can use the hub without turning off their content blocker. Support may not reach them, so use this for people on a managed device or network they cannot change themselves.`
- **Column name is `blockerGateExempt`** everywhere: Prisma field, TypeScript property, and form field `name` attribute.
- **Test DB for this worktree:** `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate"`. Storage tests also need `BLOB_READ_WRITE_TOKEN=""`.
- **Never run two full suites at once** against that database. Concurrent runs produce unique-constraint and deadlock failures that look exactly like real regressions. Check `ps aux | grep vitest` first.
- **Never pipe a test run through `tail` and trust the exit code.** A piped run returns 0 even when the suite fails. Read the pass/fail counts.
- **Full-suite baseline entering this plan:** 430 files / 4930 tests, all passing. Anything below that is a regression you introduced.
- **Lint with `npx eslint src e2e`**, never bare `eslint .`, which walks a gitignored directory and fails spuriously.

---

### Task 1: The column, and carrying it to the session

**Files:**
- Modify: `prisma/schema.prisma` (the `Person` model)
- Create: `prisma/migrations/20260812120000_add_blocker_gate_exempt/migration.sql`
- Modify: `src/platform/auth/session.ts:20-26` and `:107-113`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - Prisma field `Person.blockerGateExempt: Boolean @default(false)`
  - `PersonSession.blockerGateExempt: boolean`

- [ ] **Step 1: Add the Prisma field**

In `prisma/schema.prisma`, inside the `Person` model, add alongside the other boolean flags:

```prisma
  /// Exempts this person from the content blocker gate. Set by an admin for
  /// people on a managed device or network they cannot change themselves, who
  /// are correctly detected as blocked and genuinely cannot comply.
  blockerGateExempt Boolean @default(false)
```

Then normalize the file's column alignment:

```bash
npx prisma format
```

- [ ] **Step 2: Hand-write the migration**

Do NOT run `prisma migrate dev`. It folds any pre-existing drift in this database into your migration, which then ships someone else's unrelated schema change. Create the file directly:

`prisma/migrations/20260812120000_add_blocker_gate_exempt/migration.sql`

```sql
-- Additive and defaulted on purpose: nothing existing reads this column, so a
-- deploy where code and database briefly disagree cannot break. Older code
-- ignores it; newer code sees the default.
ALTER TABLE "Person" ADD COLUMN "blockerGateExempt" BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 3: Apply it to the test database and regenerate the client**

```bash
DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" DATABASE_URL_UNPOOLED="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" npx prisma migrate deploy
npx prisma generate
```

Expected: `migrate deploy` reports 1 migration applied. `prisma generate` is safe here because this worktree has its own real `node_modules` directory, not the symlink older worktrees used.

- [ ] **Step 4: Carry it on the session payload**

`src/platform/auth/session.ts`. Extend the type (currently lines 20-26):

```ts
export type PersonSession = {
  personId: string;
  name: string | null;
  email: string | null;
  themePreference: string | null;
  photoVersion: number;
  /** True when an admin has exempted this person from the content blocker gate. */
  blockerGateExempt: boolean;
};
```

And populate it in `requirePersonSession` (currently lines 107-113), which already holds the full `Person` row from `getActivePerson`, so this adds no query:

```ts
  const result: PersonSession = {
    personId: person.id,
    name: person.name,
    email: person.contactEmail ?? session.user?.email ?? null,
    themePreference: person.themePreference ?? null,
    photoVersion: person.photoVersion,
    blockerGateExempt: person.blockerGateExempt,
  };
```

- [ ] **Step 5: Verify**

Typecheck is the real check here: `PersonSession` is constructed in more than one place if any test or helper builds one, and the compiler will name each site.

```bash
npm run typecheck
```
Expected: clean. If it reports a missing `blockerGateExempt` on an object literal somewhere, add `blockerGateExempt: false` there rather than making the field optional. The field being required is what forces every construction site to think about it.

Then the full suite, with nothing else running:

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" BLOB_READ_WRITE_TOKEN="" npm test
```
Expected: 430 files / 4930 tests, all passing.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260812120000_add_blocker_gate_exempt src/platform/auth/session.ts
git commit -m "feat(support): add a per-person blocker gate exemption column

Carried on PersonSession, which already holds the full Person row from
getActivePerson, so the gate decision costs no extra query.

Additive and defaulted, so a deploy where code and database briefly disagree
cannot break: older code ignores the column, newer code sees the default."
```

---

### Task 2: The mount predicate, and wiring it in

**Files:**
- Create: `src/platform/intercom/gate-mount.ts`
- Test: `src/platform/intercom/gate-mount.test.ts`
- Modify: `src/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: `PersonSession.blockerGateExempt` from Task 1.
- Produces: `shouldMountBlockerGate(input: { supportAppId: string | null; gateEnabled: boolean; personExempt: boolean }): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/platform/intercom/gate-mount.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shouldMountBlockerGate } from "./gate-mount";

const ON = { supportAppId: "abc123", gateEnabled: true, personExempt: false };

describe("shouldMountBlockerGate", () => {
  it("mounts when the integration is on, the switch is on, and the person is not exempt", () => {
    expect(shouldMountBlockerGate(ON)).toBe(true);
  });

  it("does not mount without an app id, which is what keeps a hard block out of CI and preview", () => {
    expect(shouldMountBlockerGate({ ...ON, supportAppId: null })).toBe(false);
  });

  it("does not mount when ops have stood the gate down globally", () => {
    expect(shouldMountBlockerGate({ ...ON, gateEnabled: false })).toBe(false);
  });

  it("does not mount for an exempted person", () => {
    expect(shouldMountBlockerGate({ ...ON, personExempt: true })).toBe(false);
  });

  it("treats an empty app id as absent, since that is how the e2e web server disables it", () => {
    expect(shouldMountBlockerGate({ ...ON, supportAppId: "" })).toBe(false);
  });

  it("stays off when several switches are off at once", () => {
    expect(
      shouldMountBlockerGate({ supportAppId: null, gateEnabled: false, personExempt: true })
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" npx vitest run src/platform/intercom/gate-mount.test.ts
```
Expected: FAIL, cannot resolve `./gate-mount`.

- [ ] **Step 3: Write the predicate**

Create `src/platform/intercom/gate-mount.ts`:

```ts
/**
 * Whether the content blocker gate should mount for this person on this request.
 *
 * The gate blocks the whole app with a modal that cannot be dismissed, so it has
 * three independent off-switches and getting the combination wrong fails badly in
 * both directions: too permissive fires a hard block in CI or for someone who
 * cannot comply, too strict silently disables the feature. Three booleans ANDed
 * inline in JSX is exactly where that mistake hides, so the rule lives here, with
 * tests, rather than in the layout's markup.
 *
 * Deliberately NOT the condition for the Messenger itself, which mounts on the
 * app id alone. Every switch here only ever subtracts the gate: standing the gate
 * down must never take support away from the people who can still reach it.
 */
export function shouldMountBlockerGate(input: {
  /** Null (or empty) whenever Intercom is unconfigured: dev, CI, e2e, preview, demo. */
  supportAppId: string | null;
  /** The support.blockerGateEnabled setting, the runtime kill switch for an outage. */
  gateEnabled: boolean;
  /** Person.blockerGateExempt, for someone on a device or network they cannot change. */
  personExempt: boolean;
}): boolean {
  if (!input.supportAppId) return false;
  if (!input.gateEnabled) return false;
  if (input.personExempt) return false;
  return true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" npx vitest run src/platform/intercom/gate-mount.test.ts
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into the layout**

In `src/app/(app)/layout.tsx`, add the import beside the other intercom imports:

```tsx
import { shouldMountBlockerGate } from "@/platform/intercom/gate-mount";
```

Below the existing `const supportAppId = ...` line, add:

```tsx
  const mountBlockerGate = shouldMountBlockerGate({
    supportAppId,
    gateEnabled: blockerGateEnabled,
    personExempt: person.blockerGateExempt,
  });
```

Then replace the JSX block that currently reads:

```tsx
      {supportAppId ? (
        <>
          <IntercomMessenger appId={supportAppId} />
          {blockerGateEnabled ? (
            <BlockerGate appId={supportAppId} supportEmail={supportContact.email} />
          ) : null}
        </>
      ) : null}
```

with:

```tsx
      {supportAppId ? <IntercomMessenger appId={supportAppId} /> : null}
      {mountBlockerGate && supportAppId ? (
        <BlockerGate appId={supportAppId} supportEmail={supportContact.email} />
      ) : null}
```

The `&& supportAppId` is redundant with the predicate but satisfies TypeScript, which cannot narrow `supportAppId` to a string through a boolean computed elsewhere. Keep it, and do not "simplify" it away with a non-null assertion.

Update the long explanatory comment above that block so it describes three conditions rather than two, keeping its existing points about CI/e2e/preview and the one-way kill switch, and adding that a per-person exemption is the third switch, for people correctly detected as blocked who cannot comply.

- [ ] **Step 6: Verify**

```bash
npm run typecheck
npx eslint src e2e
```
Expected: typecheck clean; lint 0 errors (2 pre-existing `<img>` warnings in untouched files are expected).

- [ ] **Step 7: Commit**

```bash
git add src/platform/intercom/gate-mount.ts src/platform/intercom/gate-mount.test.ts "src/app/(app)/layout.tsx"
git commit -m "feat(support): give the gate one named mount rule, with an exemption

Three independent off-switches ANDed inline in JSX is where a subtle mistake
hides, and this one fails badly in both directions: too permissive fires a hard
block in CI or at someone who cannot comply, too strict disables the feature
silently. The rule now has a name and tests.

Every switch only ever subtracts the gate. The Messenger still mounts on the
app id alone, so exempting someone removes the block, not their support."
```

---

### Task 3: The admin checkbox

**Files:**
- Modify: `src/platform/people.ts` (`PersonInput` at :95-107, the create path at :147-148, the `fields` array at :191-203)
- Modify: `src/modules/admin/components/person-form.tsx` (the `person` Pick at :22-35, the checkbox block ending at :138)
- Modify: `src/app/(app)/admin/people/[id]/page.tsx:52-63`
- Test: `src/platform/people.test.ts` (append)

**Interfaces:**
- Consumes: the `Person.blockerGateExempt` column from Task 1.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Append these two cases to the existing `describe("updatePersonFields", ...)` block in `src/platform/people.test.ts`. They follow that file's established idiom exactly: the module-level `const ACTOR = "actor-person-id"`, `createPersonRecord` for setup, `prisma.auditLog.deleteMany()` to isolate the audit assertion, and reading `before`/`after` off the `person.update` entry.

```ts
  it("persists and audits the blocker gate exemption when an admin sets it", async () => {
    const person = await createPersonRecord(ACTOR, { name: "Managed Laptop", netId: "mgd1" });
    await prisma.auditLog.deleteMany();

    const updated = await updatePersonFields(ACTOR, person.id, { blockerGateExempt: true });
    expect(updated.blockerGateExempt).toBe(true);

    // The exemption is a bypass of a control that otherwise cannot be dismissed,
    // so who granted it has to be recoverable.
    const logs = await prisma.auditLog.findMany({ where: { action: "person.update" } });
    expect(logs).toHaveLength(1);
    expect((logs[0].before as Record<string, unknown>).blockerGateExempt).toBe(false);
    expect((logs[0].after as Record<string, unknown>).blockerGateExempt).toBe(true);
  });

  it("leaves an existing exemption alone when the key is absent from the input", async () => {
    const person = await createPersonRecord(ACTOR, {
      name: "Already Exempt",
      netId: "mgd2",
      blockerGateExempt: true,
    });
    await prisma.auditLog.deleteMany();

    // An unrelated edit from the same admin form must not silently revoke it.
    const updated = await updatePersonFields(ACTOR, person.id, { name: "Renamed Person" });
    expect(updated.blockerGateExempt).toBe(true);
  });
```

The second case is the one that matters most: the admin form posts every field on every save, so a bug in the create path or the diff could silently revoke someone's exemption during an unrelated name change, and they would be hard-blocked with no indication why.

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" npx vitest run src/platform/people.test.ts
```
Expected: FAIL. `blockerGateExempt` is not a known key of `PersonInput`, so this fails to compile or the field is never written.

- [ ] **Step 3: Add the field to PersonInput and the audited fields list**

In `src/platform/people.ts`, extend the type (currently ending at line 107):

```ts
  licensedRN?: boolean;
  blockerGateExempt?: boolean;
};
```

Add it to the `fields` array in `updatePersonFields` (currently lines 191-203), after `"licensedRN"`:

```ts
    "licensedRN",
    "blockerGateExempt",
```

That array is what the transaction diffs to decide both what to write and what to audit, so adding the key here is the whole wiring: the exemption becomes audited (who set it, when) with no further work.

Also set it on the create path beside the other booleans (currently lines 147-148), so a person created with the flag keeps it:

```ts
        licensedRN: data.licensedRN ?? false,
        blockerGateExempt: data.blockerGateExempt ?? false,
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" npx vitest run src/platform/people.test.ts
```
Expected: PASS, including your two new cases.

- [ ] **Step 5: Add the checkbox to the form**

In `src/modules/admin/components/person-form.tsx`, add to the `person` Pick (currently ending `| "licensedRN"` at line 34):

```ts
    | "licensedRN"
    | "blockerGateExempt"
```

Then add a new block after the `spanishVerified` block (the `<div className="flex flex-col gap-1">` that ends at line 138), inside the same `<div className="space-y-4">`:

```tsx
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm text-foreground-soft">
              <Checkbox
                name="blockerGateExempt"
                defaultChecked={person?.blockerGateExempt ?? false}
              />
              Skip the content blocker check
            </label>
            <p className="text-xs text-subtle-foreground">
              This person can use the hub without turning off their content blocker.
              Support may not reach them, so use this for people on a managed device or
              network they cannot change themselves.
            </p>
          </div>
```

The help text is required, not decoration: the admin ticking this is deciding on someone else's behalf, and the consequence (support may not reach them) is not guessable from the label.

- [ ] **Step 6: Read it off the form**

In `src/app/(app)/admin/people/[id]/page.tsx`, in `updateAction` (currently lines 52-63), add after `licensedRN`:

```ts
        licensedRN: formData.get("licensedRN") === "on",
        blockerGateExempt: formData.get("blockerGateExempt") === "on",
```

Note this is the edit page only. The create page (`admin/people/new`) is deliberately left alone: a brand new person has no established blocker problem, and the exemption belongs on the page where an admin is responding to one.

- [ ] **Step 7: Verify everything**

Check nothing else is running first, then run all three:

```bash
ps aux | grep vitest
TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_blockergate" BLOB_READ_WRITE_TOKEN="" npm test
npm run typecheck
npx eslint src e2e
```
Expected: **431 files / 4938 tests, zero failures.** That is the 430/4930 baseline plus one new file with 6 tests (Task 2) plus 2 tests added to an existing file (Task 3). Typecheck clean; lint 0 errors, with 2 pre-existing `<img>` warnings in untouched files.

If you see failures mentioning unique constraints on term codes, foreign keys, or deadlocks, that is test-database contention from a concurrent run, not a regression. Confirm no other vitest process is running and re-run before concluding anything.

- [ ] **Step 8: Commit**

```bash
git add src/platform/people.ts src/platform/people.test.ts src/modules/admin/components/person-form.tsx "src/app/(app)/admin/people/[id]/page.tsx"
git commit -m "feat(support): let an admin exempt one person from the blocker gate

Adding the key to updatePersonFields' fields array is the whole wiring: that
array is what the transaction diffs, so the exemption is audited (who set it,
when) without any additional code.

The help text is required rather than decorative. The admin ticking this is
deciding on someone else's behalf, and the consequence, that support may not
reach that person, is not guessable from the label."
```

---

## Notes for the implementer

- **The exemption subtracts the gate, never the Messenger.** If you find yourself gating `IntercomMessenger` on the exemption or the kill switch, stop: exempting someone must not take their support away, and that asymmetry is the point of both switches.
- **Do not make `PersonSession.blockerGateExempt` optional** to silence a typecheck error. The field being required is what forces every construction site to decide, and a silently-defaulted `undefined` reads as "not exempt" in a way nobody chose.
- **Do not add a reason field or an expiry.** Both were considered and rejected in the spec. An expiry that lapses silently would hard-block someone with no warning, which is the exact failure this flag exists to prevent.
