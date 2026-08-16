# Clearance Reminder Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the one bundled `compliance-reminder` email into a HIPAA-only member reminder, a daily onboarding-requirements member reminder, and a weekly per-director clearance digest that replaces threshold escalation.

**Architecture:** One engine (`src/platform/email/reminders.ts`) keeps making a single pass over active-term members, but produces three streams instead of one. The HIPAA leg reads `effectiveComplianceStatus` directly and claims on `lastRemindedAt`. The onboarding leg reads `ClearanceSummary.missing` minus `hipaa` and claims on a new `onboardingLastRemindedAt`. The digest runs after the loop over the members the loop found uncleared, and derives its weekly cadence from an ISO-week `claimReminderDispatch` rather than a new cron schedule.

**Tech Stack:** Next.js App Router, Prisma + PostgreSQL, Vitest (integration tests against a real throwaway Postgres), the in-house email template registry + render engine, `notify()` dispatcher.

**Spec:** `docs/superpowers/specs/2026-07-31-clearance-reminder-split-design.md`

## Global Constraints

- **No em-dashes or en-dashes anywhere**, including comments and email copy. The `local/no-em-dash` eslint rule fails lint.
- Run `npm run lint` (whole repo) before any push. `npm run typecheck` and `npm test` do not catch eslint boundary violations.
- Tests need the throwaway Postgres on port 5434, never Neon. Bring it up with `npm run db:up` and apply migrations with `npm run test:prepare`.
- `prisma migrate dev` folds any pre-existing drift into the new migration. Always open the generated SQL and trim it to only the intended statements.
- The email render engine supports only `{{#if}}`, `{{var}}`, and `{{{raw}}}`. There is **no** `{{#each}}`; it renders empty. Any list must be pre-rendered into a `{{{ ... }}}` slot by the context builder.
- Anything interpolated into a `{{{ raw }}}` slot that originates from user or admin data must be passed through `esc()` from `@/platform/email/render/escape`. The engine does not escape triple-brace slots.
- The full test command is `npm test` (vitest run). Target one file with `npx vitest run <path>`.

---

### Task 1: `isoWeekKey` date helper

The weekly digest derives its cadence from an ISO-week period key rather than a day-of-week branch. `src/platform/dates/logic.ts` has `isoDateKey` but no week equivalent.

**Files:**
- Modify: `src/platform/dates/logic.ts`
- Modify: `src/platform/dates/index.ts:3`
- Test: `src/platform/dates/logic.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isoWeekKey(d: Date): string`, returning e.g. `"2026-W31"`. Exported from `@/platform/dates`.

- [ ] **Step 1: Write the failing tests**

Append to `src/platform/dates/logic.test.ts`, and add `isoWeekKey` to the existing import from `./logic` at the top of the file.

```ts
describe("isoWeekKey", () => {
  it("returns the ISO year and zero-padded week", () => {
    // 2026-07-29 is a Wednesday in ISO week 31.
    expect(isoWeekKey(new Date("2026-07-29T12:00:00Z"))).toBe("2026-W31");
  });

  it("gives every day of one ISO week the same key (Monday through Sunday)", () => {
    // 2026-07-27 is a Monday; 2026-08-02 is the Sunday that closes the same week.
    expect(isoWeekKey(new Date("2026-07-27T00:00:00Z"))).toBe("2026-W31");
    expect(isoWeekKey(new Date("2026-07-28T23:59:59Z"))).toBe("2026-W31");
    expect(isoWeekKey(new Date("2026-08-02T23:59:59Z"))).toBe("2026-W31");
  });

  it("rolls to a new key on Monday", () => {
    expect(isoWeekKey(new Date("2026-08-03T00:00:00Z"))).toBe("2026-W32");
  });

  it("assigns an early-January date to the ISO year its week belongs to", () => {
    // 2027-01-01 is a Friday, which ISO 8601 places in week 53 of 2026.
    expect(isoWeekKey(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/platform/dates/logic.test.ts`
Expected: FAIL, `isoWeekKey is not a function` (or a TypeScript import error).

- [ ] **Step 3: Implement `isoWeekKey`**

Append to `src/platform/dates/logic.ts`:

```ts
/**
 * Returns an ISO-8601 week key ("2026-W31") in UTC. Every day from Monday through
 * Sunday of one week maps to the same key, which makes it usable as a periodKey for
 * a weekly claimReminderDispatch. Like isoDateKey this is a comparison key, never a
 * display value, and must never change zone.
 */
export function isoWeekKey(d: Date): string {
  const dayMs = 86_400_000;
  // ISO 8601 defines a week's year as the year containing its Thursday, so shift to
  // this date's Thursday first. That is what makes late-December and early-January
  // weeks land in the right year instead of splitting across two keys.
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (thursday.getUTCDay() + 6) % 7; // 0 = Monday
  thursday.setUTCDate(thursday.getUTCDate() - dow + 3);

  const isoYear = thursday.getUTCFullYear();

  // Week 1 is the week containing January 4th, so its Thursday is the reference point.
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDow + 3);

  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * dayMs));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Export it from the barrel**

In `src/platform/dates/index.ts`, change line 3 to:

```ts
export { isoDateKey, isoWeekKey, businessDaysSince } from "./logic";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/platform/dates/logic.test.ts`
Expected: PASS, all four new cases green.

- [ ] **Step 6: Commit**

```bash
git add src/platform/dates/logic.ts src/platform/dates/index.ts src/platform/dates/logic.test.ts
git commit -m "feat(dates): add isoWeekKey for weekly reminder period keys"
```

---

### Task 2: Retire threshold escalation

`compliance-escalation` fires per member, once per streak, at `compliance.escalationThreshold` reminders. The weekly digest replaces it. Removing it first clears the way for dropping the `escalatedAt` column in Task 3.

This leaves the branch with no director notification until Task 7 adds the digest. That is intentional; the branch is not deployable mid-plan.

**Files:**
- Modify: `src/platform/email/reminders.ts` (delete `sendEscalations`, the threshold read, the escalation call, and `escalationsSent`)
- Modify: `src/platform/email/templates/compliance.ts` (delete the `compliance-escalation` descriptor, `complianceEscalationContext`, `ComplianceEscalationParams`)
- Modify: `src/platform/notifications/registry.ts:17` (delete the entry)
- Modify: `src/platform/notifications/registry.test.ts` (delete `"compliance-escalation"` from the expected key list)
- Modify: `src/platform/settings/registry.ts:104-113` (delete the `compliance.escalationThreshold` definition)
- Modify: `src/platform/settings/service.test.ts:208` (delete the assertion)
- Modify: `src/platform/config.ts:112-127` (delete `COMPLIANCE_ESCALATION_THRESHOLD`)
- Modify: `src/platform/email/templates/compliance.golden.test.ts` (delete the escalation cases)
- Modify: `src/platform/email/reminders.test.ts` (delete the escalation describes, fix `result` shape assertions)

**Interfaces:**
- Consumes: nothing.
- Produces: `ReminderRunResult` narrows to `{ remindersSent: number; reset: number; skipped: number }`. `complianceDescriptors` no longer contains a `compliance-escalation` entry. The per-type channel setting `notifications.compliance-escalation.channel` disappears automatically, because `src/platform/settings/registry.ts:288` derives one setting per entry in `NOTIFICATION_TYPES`.

- [ ] **Step 1: Delete the escalation tests first**

In `src/platform/email/reminders.test.ts`, delete the entire `describe("escalation at threshold", ...)` block (both `it` cases, roughly lines 248 to 318). Then update the remaining `result` shape assertions:

- Line 142: change `expect(result).toEqual({ remindersSent: 0, escalationsSent: 0, reset: 0, skipped: 0 });` to `expect(result).toEqual({ remindersSent: 0, reset: 0, skipped: 0 });`
- Line 183: delete `expect(result.escalationsSent).toBe(0);`
- Delete every other `escalationsSent` assertion and every `emailLogCount("compliance-escalation")` assertion in the file. Search for both strings to be sure none survive.
- Delete `expect(row!.escalatedAt).toBeNull();` and `expect(row!.escalatedAt).not.toBeNull();` assertions. Leave `lastStatus` assertions alone for now; Task 3 removes them.

In `src/platform/email/templates/compliance.golden.test.ts`, delete the two `compliance-escalation` `it` blocks and remove `complianceEscalationContext` from the import on line 13.

In `src/platform/notifications/registry.test.ts`, delete the `"compliance-escalation",` line from the expected keys array.

In `src/platform/settings/service.test.ts`, delete line 208: `expect(await getSetting<number>("compliance.escalationThreshold")).toBe(3);`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/platform/email/reminders.test.ts src/platform/notifications/registry.test.ts`
Expected: FAIL. `reminders.test.ts` fails on the result-shape `toEqual` (the engine still returns `escalationsSent`), and `registry.test.ts` fails because `NOTIFICATION_TYPES` still contains the escalation key.

- [ ] **Step 3: Delete the escalation code**

In `src/platform/email/reminders.ts`:

- Narrow the result type:

```ts
/** Counters returned by a single engine run. */
export type ReminderRunResult = {
  remindersSent: number;
  reset: number;
  skipped: number;
};
```

- Update the initializer inside `runComplianceReminders` to `{ remindersSent: 0, reset: 0, skipped: 0 }`.
- Delete the `const threshold = await getSetting<number>("compliance.escalationThreshold");` line.
- Delete the whole `// d. Escalate once per non-compliant streak...` block (the `shouldEscalate` const, the `if (shouldEscalate)` body, and its comment).
- Delete the `claimed` lookup (`prisma.complianceReminder.findUniqueOrThrow`) that existed only to feed the escalation decision. The claim's `count === 0` check still guards the dedup window on its own.
- Delete the entire `sendEscalations` function and its doc comment at the bottom of the file.
- Delete `complianceEscalationContext` from the import block at the top.
- Update the file's header doc comment: delete numbered point 4 about escalation and the sentence about escalation emails being queued before `escalatedAt` is persisted.

In `src/platform/email/templates/compliance.ts`: delete `ComplianceEscalationParams`, `complianceEscalationContext`, and the `compliance-escalation` object from `complianceDescriptors`. Update the file's header comment so it no longer describes two templates.

**Keep `READABLE_STATUS`, and export it.** It is currently private and used only by the escalation builder, so the reflex is to delete it, but Task 7's digest needs exactly this map. Change its declaration to:

```ts
/** Short human phrase per HIPAA status. Consumed by the director-facing digest. */
export const READABLE_STATUS: Record<ComplianceStatus, string> = {
```

In `src/platform/notifications/registry.ts`: delete line 17.

In `src/platform/settings/registry.ts`: delete the `define<number>({ key: "compliance.escalationThreshold", ... })` block.

In `src/platform/config.ts`: delete the `COMPLIANCE_ESCALATION_THRESHOLD` block including its two-line leading comment.

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `npm test`
Expected: PASS. If anything still references `compliance-escalation` or `escalationThreshold`, it surfaces here.

Run: `grep -rn "compliance-escalation\|escalationThreshold\|COMPLIANCE_ESCALATION" src e2e docs prisma`
Expected: only `docs/cron-jobs.md` (updated in Task 7) and the spec file.

- [ ] **Step 5: Lint and typecheck**

Run: `npm run typecheck && npx eslint src`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(compliance): retire threshold escalation ahead of the weekly digest"
```

---

### Task 3: Rename the state model, add the onboarding leg columns, backfill

`ComplianceReminder` becomes `MemberReminderState` and gains per-leg state. `@@map` keeps the physical table name so the migration carries no rename.

**Files:**
- Modify: `prisma/schema.prisma:999-1007`
- Create: `prisma/migrations/<timestamp>_member_reminder_state/migration.sql`
- Modify: `src/platform/email/reminders.ts` (call sites: `prisma.complianceReminder` becomes `prisma.memberReminderState`, drop the `lastStatus` write)
- Modify: `src/platform/email/reminders.test.ts` (`getReminderRow` helper, `lastStatus` assertions)

**Interfaces:**
- Consumes: nothing.
- Produces: the Prisma accessor `prisma.memberReminderState`, with fields `personId`, `remindersSent`, `lastRemindedAt`, `onboardingRemindersSent`, `onboardingLastRemindedAt`, `stalledSince`.

- [ ] **Step 1: Update the schema**

Replace `prisma/schema.prisma:999-1007` with:

```prisma
/// Per-person reminder state for the clearance engine. One row per person, with an
/// independent claim per leg: `lastRemindedAt` paces the HIPAA reminder, and
/// `onboardingLastRemindedAt` paces the onboarding-requirements reminder, which runs
/// on a much shorter interval. `stalledSince` is stamped on the first nag of a streak
/// and cleared when both legs are satisfied; the weekly director digest sorts and
/// flags on it. Mapped to the original table name so the rename cost no migration.
model MemberReminderState {
  id                       String    @id @default(cuid())
  personId                 String    @unique
  remindersSent            Int       @default(0)
  lastRemindedAt           DateTime?
  onboardingRemindersSent  Int       @default(0)
  onboardingLastRemindedAt DateTime?
  stalledSince             DateTime?
  person                   Person    @relation(fields: [personId], references: [id], onDelete: Cascade)

  @@map("ComplianceReminder")
}
```

Then find the back-relation on the `Person` model (search for `ComplianceReminder` in `prisma/schema.prisma`) and rename its type to `MemberReminderState`, keeping the existing field name.

- [ ] **Step 2: Generate the migration**

```bash
npm run db:up
npx prisma migrate dev --name member_reminder_state --create-only
```

`--create-only` writes the SQL without applying it, so it can be inspected and edited first. **Open the generated file and trim it.** `prisma migrate dev` folds any pre-existing drift into the new migration; anything not listed in Step 3 must be deleted.

- [ ] **Step 3: Write the migration SQL by hand**

Replace the generated `migration.sql` contents with exactly this. Order matters: the backfill reads `lastRemindedAt`, which is retained, and must run before the drops.

```sql
-- Add the onboarding leg's own claim state plus the shared stall marker.
ALTER TABLE "ComplianceReminder"
  ADD COLUMN "onboardingRemindersSent" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "onboardingLastRemindedAt" TIMESTAMP(3),
  ADD COLUMN "stalledSince" TIMESTAMP(3);

-- Backfill. Without this, the first run after deploy sees a null
-- onboardingLastRemindedAt on every row and sends an onboarding reminder to every
-- uncleared member regardless of when they last heard from the HIPAA stream: a
-- one-time double-tap on exactly the population already getting the most email.
-- Seeding stalledSince from the same column also gives the first weekly digest a
-- real "outstanding since" per member instead of showing everyone as new.
UPDATE "ComplianceReminder"
SET "onboardingLastRemindedAt" = "lastRemindedAt",
    "stalledSince" = "lastRemindedAt"
WHERE "lastRemindedAt" IS NOT NULL;

-- The threshold escalation these guarded is gone (see the weekly clearance digest),
-- and lastStatus was written but never read.
ALTER TABLE "ComplianceReminder" DROP COLUMN "escalatedAt";
ALTER TABLE "ComplianceReminder" DROP COLUMN "lastStatus";
```

- [ ] **Step 4: Apply the migration and regenerate the client**

```bash
npx prisma migrate dev
npm run test:prepare
```

Expected: the migration applies cleanly and the Prisma client regenerates. If the test database reports drift, resolve it with `npx prisma migrate resolve --applied <migration_name>` then `npx prisma migrate deploy`.

- [ ] **Step 5: Update the call sites**

In `src/platform/email/reminders.ts`, replace all four `prisma.complianceReminder` occurrences with `prisma.memberReminderState` (the `findMany`, the `upsert`, the `updateMany`, and the reset `update`). In the claim's `data`, delete `lastStatus: status` so it reads:

```ts
data: { lastRemindedAt: now, remindersSent: { increment: 1 } },
```

In the reset `update`, delete `lastStatus: null` and `escalatedAt: null` so it reads:

```ts
data: {
  remindersSent: 0,
  lastRemindedAt: null,
},
```

Update the reset guard, which currently tests `existing.escalatedAt !== null`:

```ts
if (
  existing !== null &&
  (existing.remindersSent > 0 || existing.lastRemindedAt !== null)
) {
```

In `src/platform/email/reminders.test.ts`, update the helper at line 129:

```ts
async function getReminderRow(personId: string) {
  return prisma.memberReminderState.findUnique({ where: { personId } });
}
```

Search the file for `lastStatus` and delete every assertion on it. One fixture seeds a row with `lastStatus: null` and `escalatedAt: null`; delete both keys from it. Task 2 shifted the line numbers, so search rather than seeking by line.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean. A stale Prisma client is the usual cause of a false failure here; re-run `npx prisma generate` if types look wrong.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(db): rename ComplianceReminder to MemberReminderState with per-leg state"
```

---

### Task 4: Narrow `compliance-reminder` to HIPAA only

Strip the grafted-on EHS and onboarding slots. This makes the HIPAA email wrong until Task 6 stops the engine passing those params, which is fine because the params become optional no-ops immediately.

**Files:**
- Modify: `src/platform/email/templates/compliance.ts` (`ComplianceReminderParams`, `complianceReminderContext`, the `compliance-reminder` descriptor)
- Modify: `src/platform/email/templates/compliance.golden.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `complianceReminderContext(p: { personName: string; status: ComplianceStatus; expiresAt: Date | null; appUrl?: string; brandColor?: string })`. The `ehsMissing` and `otherItems` params are gone. The context no longer emits `ehsMissingList`, `hasEhsGap`, `otherItemsHtml`, or `hasOtherItems`.

- [ ] **Step 1: Write the failing test**

Assert against the **descriptor**, not the rendered output. A rendered-output assertion would pass before the change is made: the grafted-on copy sits inside `{{#if hasEhsGap}}` and `{{#if hasOtherItems}}` blocks, and a context that omits those keys renders them as false, so the EHS paragraph is already absent from the HTML. Only the descriptor itself distinguishes before from after.

Add to `src/platform/email/templates/compliance.golden.test.ts`, importing `getDescriptor` from `./registry`:

```ts
describe("compliance-reminder descriptor is HIPAA only", () => {
  it("declares no EHS or onboarding variables", () => {
    const names = getDescriptor("compliance-reminder")!.variables.map((v) => v.name);
    expect(names).not.toContain("ehsMissingList");
    expect(names).not.toContain("hasEhsGap");
    expect(names).not.toContain("otherItemsHtml");
    expect(names).not.toContain("hasOtherItems");
  });

  it("has no EHS or onboarding blocks in its body, and a HIPAA-specific subject", () => {
    const d = getDescriptor("compliance-reminder")!;
    expect(d.defaultBody).not.toContain("hasEhsGap");
    expect(d.defaultBody).not.toContain("hasOtherItems");
    expect(d.defaultBody).not.toContain("before you are cleared to volunteer");
    expect(d.defaultSubject).toBe("[HAVEN] HIPAA certification reminder");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/platform/email/templates/compliance.golden.test.ts`
Expected: FAIL on all six assertions. The descriptor still declares the four variables, its body still contains both `{{#if}}` blocks, and its subject is still `"[HAVEN] Compliance reminder"`.

- [ ] **Step 3: Narrow the params and context builder**

In `src/platform/email/templates/compliance.ts`, replace `ComplianceReminderParams` with:

```ts
export type ComplianceReminderParams = {
  personName: string;
  status: ComplianceStatus;
  expiresAt: Date | null;
  /**
   * Base URL of the hub (e.g. https://hub.havenfreeclinic.org), used to build the
   * "Open HAVEN Hub" call-to-action that links the member to My Info. The sole
   * production caller (reminders.ts) always supplies it.
   */
  appUrl?: string;
  /** Resolved `branding.brandColor`, used for the CTA button background. */
  brandColor?: string;
};
```

Delete the `itemsToHtml` helper (Task 5 introduces its escaping replacement in the new file).

In `complianceReminderContext`, delete the `case "COMPLIANT":` branch entirely. It existed only so a member with a current certificate but an outstanding EHS item still received this email; with the split, a COMPLIANT status never reaches this builder and the `default` throw is the correct response if it somehow does. Add a comment saying so:

```ts
    // No COMPLIANT branch: the engine only calls this for a member whose HIPAA
    // status is actually unsatisfied. A COMPLIANT status reaching here means the
    // caller's gate is wrong, so the default throw below is the right answer.
```

Replace the return with:

```ts
  return {
    personName: p.personName,
    statusLine,
    actionLine,
    showCta,
    ctaUrl: `${p.appUrl ?? ""}/my-info`,
    brandColor: p.brandColor ?? "",
  };
```

- [ ] **Step 4: Narrow the descriptor**

In the `compliance-reminder` descriptor, delete the last four `variables` entries (`ehsMissingList`, `hasEhsGap`, `otherItemsHtml`, `hasOtherItems`) and replace `defaultBody` with:

```ts
    defaultBody: `<p>Hello {{ personName }},</p>

<p>{{ statusLine }}</p>

{{#if showCta}}<p>Please upload or renew your certificate in <a href="{{ ctaUrl }}">HAVEN Hub</a>.</p>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 18px;">
  <tr>
    <td style="border-radius: 6px; background-color: {{ brandColor }};">
      <a href="{{ ctaUrl }}" style="display: inline-block; padding: 12px 24px; font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none;">Open HAVEN Hub &rarr;</a>
    </td>
  </tr>
</table>{{else}}<p>{{ actionLine }}</p>{{/if}}

<p>Thank you,<br>HAVEN Free Clinic</p>`,
```

Also change `defaultSubject` from `"[HAVEN] Compliance reminder"` to `"[HAVEN] HIPAA certification reminder"`, so the subject matches what the email is now about.

- [ ] **Step 5: Fix the existing golden tests**

The `actionableBody` helper at the top of `compliance.golden.test.ts` still matches, since the actionable path is unchanged. Any existing case that passed `ehsMissing` or `otherItems` into `complianceReminderContext` no longer typechecks; delete those arguments. Search the file for `ehsMissing` and `otherItems`.

- [ ] **Step 6: Stop the engine passing the removed params**

`src/platform/email/reminders.ts` still passes `ehsMissing` and `otherItems` into `complianceReminderContext`, which no longer typechecks. Delete those two properties from that call so this task's commit stands on its own:

```ts
    const renderedReminder = await renderEmail(
      "compliance-reminder",
      complianceReminderContext({
        personName: person.name,
        status: effectiveStatus,
        expiresAt,
        appUrl: baseUrl,
        brandColor,
      }),
    );
```

Leave the local `ehsMissing` and `otherItems` consts in place. They are still read by the `isDone` gate a few lines above, so nothing goes unused. Task 6 restructures that gate.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS and clean.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(email): narrow compliance-reminder back to HIPAA only"
```

---

### Task 5: Add the `onboarding-reminder` template and its cadence setting

**Files:**
- Create: `src/platform/email/templates/clearance.ts`
- Create: `src/platform/email/templates/clearance.golden.test.ts`
- Modify: `src/platform/email/templates/registry.ts` (import + spread)
- Modify: `src/platform/notifications/registry.ts` (new type)
- Modify: `src/platform/notifications/registry.test.ts` (expected keys)
- Modify: `src/platform/settings/registry.ts` (new setting)
- Modify: `src/platform/settings/service.test.ts` (assert the default)
- Modify: `src/platform/config.ts` (new env var)

**Interfaces:**
- Consumes: `esc` from `@/platform/email/render/escape`, `TemplateDescriptor` from `./types`.
- Produces:
  - `onboardingReminderContext(p: { personName: string; items: string[]; appUrl?: string; brandColor?: string }): Record<string, unknown>`
  - `clearanceDescriptors: TemplateDescriptor[]` (holds `onboarding-reminder` now, gains `clearance-digest` in Task 7)
  - `itemsToHtml(items: string[]): string`, an escaping list renderer shared with Task 7
  - Setting `onboarding.reminderIntervalDays`, default 1
  - Notification type `onboarding-reminder`

- [ ] **Step 1: Write the failing tests**

Create `src/platform/email/templates/clearance.golden.test.ts`:

```ts
/**
 * Golden tests for the clearance email templates (onboarding reminder and the
 * weekly director digest), rendered through renderEmail so the branded layout is
 * exercised the same way the compliance templates are.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { renderEmail } from "./renderEmail";
import { onboardingReminderContext } from "./clearance";

beforeEach(resetDb);

const APP_URL = "https://hub.example.org";
const BRAND = "#00356b";

describe("onboarding-reminder", () => {
  it("lists every outstanding item as its own row", async () => {
    const out = await renderEmail(
      "onboarding-reminder",
      onboardingReminderContext({
        personName: "Jane Doe",
        items: [
          "Confirm your contact details in your profile",
          "Complete your assigned learning courses",
        ],
        appUrl: APP_URL,
        brandColor: BRAND,
      }),
    );
    expect(out.subject).toBe("[HAVEN] Outstanding onboarding requirements");
    expect(out.html).toContain("<li>Confirm your contact details in your profile</li>");
    expect(out.html).toContain("<li>Complete your assigned learning courses</li>");
    expect(out.html).toContain(`${APP_URL}/get-started`);
  });

  it("escapes item text, which can carry admin-entered EHS course names", async () => {
    const out = await renderEmail(
      "onboarding-reminder",
      onboardingReminderContext({
        personName: "Jane Doe",
        items: ['Complete your required EHS training: <script>alert("x")</script>'],
        appUrl: APP_URL,
        brandColor: BRAND,
      }),
    );
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });

  it("uses the singular noun for a single outstanding item", async () => {
    const out = await renderEmail(
      "onboarding-reminder",
      onboardingReminderContext({
        personName: "Jane Doe",
        items: ["Finish this term's volunteer training"],
        appUrl: APP_URL,
        brandColor: BRAND,
      }),
    );
    expect(out.html).toContain("1 item");
    expect(out.html).not.toContain("1 items");
  });
});
```

Add to `src/platform/settings/service.test.ts`, inside the same describe as the existing compliance scalar test:

```ts
  it("resolves the onboarding reminder interval from its env default", async () => {
    expect(await getSetting<number>("onboarding.reminderIntervalDays")).toBe(1);
  });
```

Add `"onboarding-reminder",` to the expected key list in `src/platform/notifications/registry.test.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/platform/email/templates/clearance.golden.test.ts src/platform/settings/service.test.ts src/platform/notifications/registry.test.ts`
Expected: FAIL. The clearance module does not exist, the setting is unknown, and the notification key is missing.

- [ ] **Step 3: Create the template module**

Create `src/platform/email/templates/clearance.ts`:

```ts
/**
 * Clearance email templates for HAVEN Hub.
 *
 * These cover everything the HIPAA certificate templates in ./compliance.ts do not:
 *   - onboarding-reminder: sent to a member with outstanding onboarding requirements
 *     (profile, EHS training, volunteer/director training, learning courses).
 *   - clearance-digest: the weekly per-director roll-up of members who are not
 *     cleared, which replaced the old per-member escalation.
 *
 * Both render lists, and the template engine has no {{#each}}, so list rows are
 * pre-rendered into a {{{ ... }}} slot here. That slot is NOT escaped by the render
 * engine, so every interpolated value passes through esc() first.
 */

import { esc } from "@/platform/email/render/escape";
import type { TemplateDescriptor } from "./types";

// ---------------------------------------------------------------------------
// Param types
// ---------------------------------------------------------------------------

export type OnboardingReminderParams = {
  personName: string;
  /** Ready-to-display sentences, one per outstanding requirement. */
  items: string[];
  /** Base URL of the hub, used to build the "Get started" call-to-action. */
  appUrl?: string;
  /** Resolved `branding.brandColor`, used for the CTA button background. */
  brandColor?: string;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Render sentences as <li> rows for a {{{ raw }}} slot. Unlike the version this
 * replaced, every item is escaped: item text now interpolates admin-entered EHS
 * course names, so it is no longer a set of hardcoded internal labels.
 */
export function itemsToHtml(items: string[]): string {
  return items.map((i) => `<li>${esc(i)}</li>`).join("");
}

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

export function onboardingReminderContext(p: OnboardingReminderParams): Record<string, unknown> {
  const count = p.items.length;
  return {
    personName: p.personName,
    itemsHtml: itemsToHtml(p.items),
    itemCount: count,
    itemNoun: count === 1 ? "item" : "items",
    ctaUrl: `${p.appUrl ?? ""}/get-started`,
    brandColor: p.brandColor ?? "",
  };
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

export const clearanceDescriptors: TemplateDescriptor[] = [
  {
    key: "onboarding-reminder",
    name: "Onboarding: outstanding requirements",
    category: "transactional",
    group: "compliance",
    variables: [
      { name: "personName", label: "Member name", sampleValue: "Jane Doe" },
      {
        name: "itemsHtml",
        label: "Pre-rendered <li> rows, one per outstanding requirement",
        sampleValue: "<li>Complete your assigned learning courses</li>",
      },
      { name: "itemCount", label: "How many requirements are outstanding", sampleValue: "2" },
      { name: "itemNoun", label: "\"item\" or \"items\", matched to the count", sampleValue: "items" },
      {
        name: "ctaUrl",
        label: "Absolute link to the get-started checklist in HAVEN Hub",
        sampleValue: "https://hub.havenfreeclinic.org/get-started",
      },
      {
        name: "brandColor",
        label: "Brand color for the call-to-action button background (hex)",
        sampleValue: "#00356b",
      },
    ],
    defaultSubject: "[HAVEN] Outstanding onboarding requirements",
    defaultBody: `<p>Hello {{ personName }},</p>

<p>You have {{ itemCount }} {{ itemNoun }} left to finish before you are cleared to volunteer:</p>

<ul>{{{ itemsHtml }}}</ul>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 18px;">
  <tr>
    <td style="border-radius: 6px; background-color: {{ brandColor }};">
      <a href="{{ ctaUrl }}" style="display: inline-block; padding: 12px 24px; font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none;">Finish onboarding &rarr;</a>
    </td>
  </tr>
</table>

<p>Reach out to your director if you are unsure how to complete any of these.</p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
];
```

- [ ] **Step 4: Register the template, the notification type, the setting, and the env var**

In `src/platform/email/templates/registry.ts`, add the import alongside the others and spread it into the descriptor list:

```ts
import { clearanceDescriptors } from "./clearance";
```

```ts
  ...clearanceDescriptors,
```

In `src/platform/notifications/registry.ts`, add after the `compliance-reminder` entry:

```ts
  { key: "onboarding-reminder", label: "Onboarding: outstanding requirements", defaultChannel: "email" },
```

In `src/platform/config.ts`, add next to `COMPLIANCE_REMINDER_INTERVAL_DAYS`:

```ts
    // Onboarding reminder cadence: how many days between onboarding-requirement
    // emails. Default is 1 (daily), much faster than the HIPAA cadence because these
    // are tasks a new member should finish in their first week. Rejected if not a
    // positive finite number.
    ONBOARDING_REMINDER_INTERVAL_DAYS: z
      .string()
      .default("1")
      .transform(Number)
      .pipe(
        z.number().superRefine((val, ctx) => {
          if (Number.isNaN(val) || val <= 0) {
            ctx.addIssue({
              code: "custom",
              path: [],
              message: "ONBOARDING_REMINDER_INTERVAL_DAYS must be a positive number",
            });
          }
        })
      ),
```

In `src/platform/settings/registry.ts`, add after the `compliance.reminderIntervalDays` definition:

```ts
  define<number>({
    key: "onboarding.reminderIntervalDays",
    category: "Operations",
    label: "Onboarding reminder interval (days)",
    help: "Days between onboarding-requirement reminder emails. Separate from the HIPAA reminder interval, and much shorter by default.",
    input: { type: "number", min: 1 },
    schema: z.number().int().positive(),
    envDefault: () => config.ONBOARDING_REMINDER_INTERVAL_DAYS,
    secret: false,
  }),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/platform/email/templates/clearance.golden.test.ts src/platform/settings/service.test.ts src/platform/notifications/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite, lint, typecheck**

Run: `npm test && npm run typecheck && npx eslint src`
Expected: PASS and clean. `src/platform/email/templates/registry.test.ts` may assert a descriptor count or key list; update it for the new key if it fails.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(email): add the onboarding-reminder template and its cadence setting"
```

---

### Task 6: Split the engine into two member legs

The heart of the change. One pass, two independent claims, a grace period, and `stalledSince`.

**Files:**
- Modify: `src/platform/email/reminders.ts` (substantial rewrite of the per-person loop)
- Modify: `src/app/api/cron/reminders/route.ts` (renamed entry point, updated doc comment)
- Modify: `src/platform/email/reminders.test.ts` (result shape, new cases)

**Interfaces:**
- Consumes: `onboardingReminderContext` and `clearanceDescriptors` from Task 5, `loadClearanceMap` from `@/platform/clearance`, `loadEhsMissingMap` from `@/platform/ehs/services/status`, `prisma.memberReminderState` from Task 3.
- Produces:
  - `runClearanceReminders(now?: Date): Promise<ReminderRunResult>`, replacing `runComplianceReminders`
  - `ReminderRunResult` becomes `{ hipaaRemindersSent: number; onboardingRemindersSent: number; reset: number; skipped: number }` (Task 7 adds `digestsSent`)

- [ ] **Step 1: Write the failing tests**

Add to `src/platform/email/reminders.test.ts`. First update the import and add a helper to build a person who is fully cleared except for a chosen gap. Change the import on line 18 to:

```ts
import { runClearanceReminders } from "./reminders";
```

Then rename every existing `runComplianceReminders(` call in the file to `runClearanceReminders(`.

Add this helper next to the other fixture helpers:

```ts
/**
 * Backdate a person's memberships so they are past the onboarding grace period.
 * Fixtures create memberships at wall-clock "now", which is well after the pinned
 * NOW the engine is called with, so without this every fixture member looks like
 * they joined in the future and the grace guard suppresses their onboarding email.
 */
async function backdateMemberships(personId: string, when: Date) {
  await prisma.termMembership.updateMany({
    where: { personId },
    data: { createdAt: when },
  });
}

const LONG_AGO = new Date("2026-01-01T00:00:00.000Z");
```

Add these cases:

```ts
describe("stream separation", () => {
  it("sends only a HIPAA reminder when HIPAA is the sole gap", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Alice", "alice@example.com");
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRED_COMPLETION);
    await backdateMemberships(person.id, LONG_AGO);

    const result = await runClearanceReminders(NOW);

    expect(result.hipaaRemindersSent).toBe(1);
    expect(result.onboardingRemindersSent).toBe(0);
    expect(await emailLogCount("compliance-reminder")).toBe(1);
    expect(await emailLogCount("onboarding-reminder")).toBe(0);
  });

  it("sends only an onboarding reminder when HIPAA is current but the profile is incomplete", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    // No phone: createPerson defaults one, so clear it to open the profile gap.
    const person = await createPerson("Alice", "alice@example.com");
    await prisma.person.update({ where: { id: person.id }, data: { phone: null } });
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, COMPLIANT_COMPLETION);
    await backdateMemberships(person.id, LONG_AGO);

    const result = await runClearanceReminders(NOW);

    expect(result.hipaaRemindersSent).toBe(0);
    expect(result.onboardingRemindersSent).toBe(1);
    expect(await emailLogCount("compliance-reminder")).toBe(0);
    expect(await emailLogCount("onboarding-reminder")).toBe(1);
  });

  it("keeps nudging an EXPIRING_SOON certificate even though clearance treats it as complete", async () => {
    // deriveHipaaTaskState maps EXPIRING_SOON to COMPLETE, so `hipaa` is absent from
    // ClearanceSummary.missing. The HIPAA leg must read `status` directly, or the
    // renewal nudge silently disappears.
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Alice", "alice@example.com");
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRING_COMPLETION);
    await backdateMemberships(person.id, LONG_AGO);

    const result = await runClearanceReminders(NOW);

    expect(result.hipaaRemindersSent).toBe(1);
    expect(await emailLogCount("compliance-reminder")).toBe(1);
  });
});

describe("independent cadences", () => {
  it("sends the onboarding reminder daily while the HIPAA reminder waits out its 7-day window", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Alice", "alice@example.com");
    await prisma.person.update({ where: { id: person.id }, data: { phone: null } });
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRED_COMPLETION);
    await backdateMemberships(person.id, LONG_AGO);

    await runClearanceReminders(NOW);
    // Two days later: past the 1-day onboarding interval, inside the 7-day HIPAA one.
    // Not one day: the claim is a strict `lastRemindedAt < now - interval`, so at
    // exactly +1 day the cutoff equals the stamp and the claim correctly loses.
    const result = await runClearanceReminders(advanceNow(2));

    expect(result.hipaaRemindersSent).toBe(0);
    expect(result.onboardingRemindersSent).toBe(1);
    expect(await emailLogCount("compliance-reminder")).toBe(1);
    expect(await emailLogCount("onboarding-reminder")).toBe(2);
  });
});

describe("onboarding grace period", () => {
  it("suppresses the onboarding reminder for a member whose membership is a day old", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Alice", "alice@example.com");
    await prisma.person.update({ where: { id: person.id }, data: { phone: null } });
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, COMPLIANT_COMPLETION);
    await backdateMemberships(person.id, new Date(NOW.getTime() - 1 * MS_PER_DAY));

    const result = await runClearanceReminders(NOW);

    expect(result.onboardingRemindersSent).toBe(0);
    expect(await emailLogCount("onboarding-reminder")).toBe(0);
  });

  it("releases the member once the grace period has elapsed", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Alice", "alice@example.com");
    await prisma.person.update({ where: { id: person.id }, data: { phone: null } });
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, COMPLIANT_COMPLETION);
    await backdateMemberships(person.id, new Date(NOW.getTime() - 3 * MS_PER_DAY));

    const result = await runClearanceReminders(NOW);

    expect(result.onboardingRemindersSent).toBe(1);
  });

  it("does not gate the HIPAA reminder on the grace period", async () => {
    // An expired certificate is urgent regardless of how new the member is.
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Alice", "alice@example.com");
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRED_COMPLETION);
    await backdateMemberships(person.id, new Date(NOW.getTime() - 1 * MS_PER_DAY));

    const result = await runClearanceReminders(NOW);

    expect(result.hipaaRemindersSent).toBe(1);
  });
});

describe("stalledSince", () => {
  it("stamps on the first nag and holds steady across later runs", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Alice", "alice@example.com");
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRED_COMPLETION);
    await backdateMemberships(person.id, LONG_AGO);

    await runClearanceReminders(NOW);
    const first = (await getReminderRow(person.id))!.stalledSince;
    expect(first).not.toBeNull();

    await runClearanceReminders(advanceNow(ADVANCE_DAYS));
    expect((await getReminderRow(person.id))!.stalledSince?.getTime()).toBe(first?.getTime());
  });

  it("clears when both legs are satisfied", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Alice", "alice@example.com");
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRED_COMPLETION);
    await backdateMemberships(person.id, LONG_AGO);

    await runClearanceReminders(NOW);
    // Replace the expired cert with a compliant one.
    await prisma.hipaaCertificate.deleteMany({ where: { personId: person.id } });
    await addCert(person.id, COMPLIANT_COMPLETION);

    const result = await runClearanceReminders(advanceNow(ADVANCE_DAYS));

    expect(result.reset).toBe(1);
    const row = await getReminderRow(person.id);
    expect(row!.stalledSince).toBeNull();
    expect(row!.remindersSent).toBe(0);
    expect(row!.onboardingRemindersSent).toBe(0);
  });
});
```

Also update the `no active term` case's `toEqual` to the new shape:

```ts
    expect(result).toEqual({
      hipaaRemindersSent: 0,
      onboardingRemindersSent: 0,
      reset: 0,
      skipped: 0,
    });
```

And rename `result.remindersSent` to `result.hipaaRemindersSent` and `row!.remindersSent` stays as-is (the HIPAA counter keeps its column name) throughout the pre-existing cases.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/platform/email/reminders.test.ts`
Expected: FAIL, `runClearanceReminders is not exported` plus result-shape mismatches.

- [ ] **Step 3: Rewrite the engine**

In `src/platform/email/reminders.ts`, replace the header doc comment with:

```ts
/**
 * Clearance reminder engine for HAVEN Hub.
 *
 * One pass over the active term's members produces two independent member-facing
 * streams, each with its own cadence and its own atomic claim:
 *
 *   HIPAA leg (compliance-reminder, `compliance.reminderIntervalDays`, 7 by default)
 *     Driven by effectiveComplianceStatus. Unsatisfied for every status except
 *     COMPLIANT, so EXPIRING_SOON keeps producing the renewal nudge.
 *
 *     This leg MUST read `status` and not ClearanceSummary.missing:
 *     deriveHipaaTaskState maps EXPIRING_SOON to COMPLETE, so `hipaa` is absent from
 *     `missing` for a member whose certificate expires next week. Deriving this leg
 *     from `missing` silently deletes the renewal nudge.
 *
 *   Onboarding leg (onboarding-reminder, `onboarding.reminderIntervalDays`, 1 by
 *   default) Driven by ClearanceSummary.missing with `hipaa` filtered out, so it
 *     covers profile, EHS, volunteer/director training, and learning. Suppressed for
 *     the first ONBOARDING_REMINDER_GRACE_DAYS of a member's earliest active
 *     membership, so a member who accepted yesterday meets the hub through their
 *     onboarding link rather than a list of things they have not done.
 *
 * Per-term step config is honored on both legs. A disabled step is dropped from
 * `tasks` (and therefore from `missing`) by loadClearanceMap, which covers the
 * onboarding leg for free; the HIPAA leg checks for the `hipaa` task explicitly
 * because it reads `status` rather than `missing`.
 *
 * `stalledSince` is stamped on the first nag of a streak and cleared when both legs
 * are satisfied. Unlike the per-leg claims it is stamped before the reachability
 * guards, because it is a statement about the member's state rather than about
 * delivery, and the weekly director digest specifically wants to surface members no
 * channel can reach.
 *
 * All notifications are dispatched via notify(); no transport is invoked here.
 */
```

Replace the imports and constants block:

```ts
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { log } from "@/platform/logging";
import { effectiveComplianceStatus, certExpiresAt } from "@/platform/compliance/rules";
import { getActiveTerm } from "@/platform/terms/active-term";
import { notify } from "@/platform/notifications/notify";
import { resolveChannel } from "@/platform/notifications/channel";
import { renderEmail } from "./templates/renderEmail";
import { complianceReminderContext } from "./templates/compliance";
import { onboardingReminderContext } from "./templates/clearance";
import { loadEhsMissingMap } from "@/platform/ehs/services/status";
import { loadClearanceMap } from "@/platform/clearance";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Days a member is left alone before the onboarding reminder starts. Deliberately a
 * constant rather than a setting: one cadence knob is enough, and this is a fixed
 * "let them arrive first" courtesy, not an operational dial. Promote it to the
 * settings registry only if ops actually asks.
 */
const ONBOARDING_REMINDER_GRACE_DAYS = 2;

/**
 * Human-readable, self-serviceable outstanding items, keyed by onboarding task key.
 * `hipaa` is deliberately absent: it has its own stream.
 */
const REMINDER_ITEM_LABELS: Record<string, string> = {
  profile: "Confirm your contact details in your profile",
  ehs: "Complete your required EHS training",
  training: "Finish this term's volunteer training",
  directorTraining: "Finish this term's director training",
  learning: "Complete your assigned learning courses",
};

/**
 * Turn a member's missing task keys into display sentences for the onboarding email.
 * `hipaa` is dropped (its own stream covers it) and the EHS row is expanded with the
 * specific outstanding course names, which is the detail the bundled email used to
 * carry.
 */
function onboardingItems(missing: readonly string[], ehsMissing: string[]): string[] {
  const out: string[] = [];
  for (const key of missing) {
    if (key === "hipaa") continue;
    const label = REMINDER_ITEM_LABELS[key];
    if (!label) continue;
    out.push(key === "ehs" && ehsMissing.length > 0 ? `${label}: ${ehsMissing.join(", ")}` : label);
  }
  return out;
}
```

Replace the result type:

```ts
/** Counters returned by a single engine run. */
export type ReminderRunResult = {
  hipaaRemindersSent: number;
  onboardingRemindersSent: number;
  reset: number;
  skipped: number;
};
```

Rename the function and its initializer:

```ts
export async function runClearanceReminders(
  now: Date = new Date()
): Promise<ReminderRunResult> {
  const startedAt = Date.now();
  const result: ReminderRunResult = {
    hipaaRemindersSent: 0,
    onboardingRemindersSent: 0,
    reset: 0,
    skipped: 0,
  };
```

In the candidate query (step 2 of the existing function), select `createdAt` so the grace period has an input, and build the earliest-membership map:

```ts
  const membershipRows = await prisma.termMembership.findMany({
    where: { termId, status: "ACTIVE" },
    select: { personId: true, createdAt: true },
  });

  const candidateIds = Array.from(new Set(membershipRows.map((m) => m.personId)));

  // Earliest active membership per person, for the onboarding grace period.
  const joinedAt = new Map<string, Date>();
  for (const m of membershipRows) {
    const seen = joinedAt.get(m.personId);
    if (!seen || m.createdAt < seen) joinedAt.set(m.personId, m.createdAt);
  }
```

Replace the settings + channel block with both intervals and both channels:

```ts
  const hipaaIntervalMs =
    (await getSetting<number>("compliance.reminderIntervalDays")) * MS_PER_DAY;
  const onboardingIntervalMs =
    (await getSetting<number>("onboarding.reminderIntervalDays")) * MS_PER_DAY;

  const baseUrl = await getSetting<string>("app.baseUrl");
  const brandColor = await getSetting<string>("branding.brandColor");

  // Each stream resolves its own channel: an admin can route one to Teams and leave
  // the other on email. The reachability guard below is relative to whichever channel
  // will actually carry that stream's send.
  const hipaaChannel = await resolveChannel("compliance-reminder");
  const onboardingChannel = await resolveChannel("onboarding-reminder");

  const canReach = (
    channel: string,
    person: { contactEmail: string | null; entraObjectId: string | null }
  ): boolean => {
    const wantsEmail = channel === "email" || channel === "both";
    const wantsTeams = channel === "teams" || channel === "both";
    return (wantsEmail && !!person.contactEmail) || (wantsTeams && !!person.entraObjectId);
  };
```

Replace the whole per-person loop body (everything from `for (const person of persons) {` to its closing brace) with:

```ts
  for (const person of persons) {
    const certs = certsByPerson.get(person.id) ?? [];
    const cert = certs[0] ?? null;
    // Effective (all-certs) status: an early renewal awaiting verification must not
    // flip a still-cleared member back to PENDING_VERIFICATION and re-trigger nags.
    // EXPIRING_SOON is still surfaced so the renewal nudge holds.
    const status = effectiveComplianceStatus(certs, activeTerm.endDate, now);
    const clearance = clearanceByPerson.get(person.id);

    // A term can disable the HIPAA step. loadClearanceMap drops a disabled step from
    // `tasks`, so its absence means "not required this term": neutralize the leg.
    // The onboarding leg needs no equivalent, since a disabled step is already gone
    // from `missing`.
    const hipaaEnabled = clearance?.tasks.some((t) => t.key === "hipaa") ?? true;
    const hipaaStatus = hipaaEnabled ? status : "COMPLIANT";
    const hipaaUnsatisfied = hipaaStatus !== "COMPLIANT";

    const items = onboardingItems(
      clearance?.missing ?? [],
      ehsMissingByPerson.get(person.id) ?? []
    );
    const onboardingUnsatisfied = items.length > 0;

    const existing = reminderMap.get(person.id) ?? null;

    // --- Both legs satisfied: reset any lingering state ---
    if (!hipaaUnsatisfied && !onboardingUnsatisfied) {
      if (
        existing !== null &&
        (existing.remindersSent > 0 ||
          existing.onboardingRemindersSent > 0 ||
          existing.lastRemindedAt !== null ||
          existing.onboardingLastRemindedAt !== null ||
          existing.stalledSince !== null)
      ) {
        await prisma.memberReminderState.update({
          where: { personId: person.id },
          data: {
            remindersSent: 0,
            lastRemindedAt: null,
            onboardingRemindersSent: 0,
            onboardingLastRemindedAt: null,
            stalledSince: null,
          },
        });
        result.reset++;
      }
      continue;
    }

    // --- At least one leg outstanding ---

    // Ensure the row exists and stamp stalledSince if this is the start of a streak.
    // This runs before the reachability guards on purpose: an unreachable member is
    // exactly who a director needs to see in the weekly digest, and stalledSince is a
    // fact about the member's state, not about whether a send landed.
    await prisma.memberReminderState.upsert({
      where: { personId: person.id },
      create: { personId: person.id, stalledSince: now },
      update: {},
    });
    await prisma.memberReminderState.updateMany({
      where: { personId: person.id, stalledSince: null },
      data: { stalledSince: now },
    });

    // --- HIPAA leg ---
    if (hipaaUnsatisfied) {
      if (!canReach(hipaaChannel, person)) {
        log.info(
          `[reminders] Skipping HIPAA reminder for ${person.id} (${person.name}): channel ${hipaaChannel} cannot reach them.`,
          { personId: person.id },
        );
        result.skipped++;
      } else {
        // Atomic claim: updateMany cannot be won twice, so two overlapping cron runs
        // cannot both send. Claiming before the send trades a possible lost reminder
        // on a mid-run crash (recovered next interval) for guaranteed no duplicates.
        const claim = await prisma.memberReminderState.updateMany({
          where: {
            personId: person.id,
            OR: [
              { lastRemindedAt: null },
              { lastRemindedAt: { lt: new Date(now.getTime() - hipaaIntervalMs) } },
            ],
          },
          data: { lastRemindedAt: now, remindersSent: { increment: 1 } },
        });
        if (claim.count === 0) {
          result.skipped++;
        } else {
          const expiresAt = cert?.completionDate ? certExpiresAt(cert.completionDate) : null;
          const rendered = await renderEmail(
            "compliance-reminder",
            complianceReminderContext({
              personName: person.name,
              status: hipaaStatus,
              expiresAt,
              appUrl: baseUrl,
              brandColor,
            }),
          );
          await notify(prisma, {
            type: "compliance-reminder",
            person: {
              id: person.id,
              entraObjectId: person.entraObjectId,
              contactEmail: person.contactEmail,
            },
            email: { subject: rendered.subject, html: rendered.html },
            teams: {
              title: "HIPAA certification reminder",
              summary: "Your HIPAA certification needs attention. Please review it in HAVEN Hub.",
              link: `${baseUrl}/my-info`,
            },
          });
          result.hipaaRemindersSent++;
        }
      }
    }

    // --- Onboarding leg ---
    if (onboardingUnsatisfied) {
      const joined = joinedAt.get(person.id);
      const inGrace =
        joined !== undefined &&
        now.getTime() - joined.getTime() < ONBOARDING_REMINDER_GRACE_DAYS * MS_PER_DAY;

      if (inGrace) {
        result.skipped++;
      } else if (!canReach(onboardingChannel, person)) {
        log.info(
          `[reminders] Skipping onboarding reminder for ${person.id} (${person.name}): channel ${onboardingChannel} cannot reach them.`,
          { personId: person.id },
        );
        result.skipped++;
      } else {
        const claim = await prisma.memberReminderState.updateMany({
          where: {
            personId: person.id,
            OR: [
              { onboardingLastRemindedAt: null },
              { onboardingLastRemindedAt: { lt: new Date(now.getTime() - onboardingIntervalMs) } },
            ],
          },
          data: {
            onboardingLastRemindedAt: now,
            onboardingRemindersSent: { increment: 1 },
          },
        });
        if (claim.count === 0) {
          result.skipped++;
        } else {
          const rendered = await renderEmail(
            "onboarding-reminder",
            onboardingReminderContext({
              personName: person.name,
              items,
              appUrl: baseUrl,
              brandColor,
            }),
          );
          await notify(prisma, {
            type: "onboarding-reminder",
            person: {
              id: person.id,
              entraObjectId: person.entraObjectId,
              contactEmail: person.contactEmail,
            },
            email: { subject: rendered.subject, html: rendered.html },
            teams: {
              title: "Outstanding onboarding requirements",
              summary: `You have ${items.length} item${items.length === 1 ? "" : "s"} left before you are cleared to volunteer.`,
              link: `${baseUrl}/get-started`,
            },
          });
          result.onboardingRemindersSent++;
        }
      }
    }
  }
```

Task 7 appends one more statement to the end of this loop body. Nothing else is left dangling here.

Update the trailing log call to the new counters (it already spreads `...result`, so only the comment needs a pass).

- [ ] **Step 4: Update the cron route**

Replace `src/app/api/cron/reminders/route.ts` lines 1 to 20 with:

```ts
/**
 * Daily clearance reminders: the HIPAA certificate stream and the onboarding
 * requirements stream. Per-person, per-leg dedup lives inside
 * runClearanceReminders, so a daily trigger is safe for both even though their
 * intervals differ.
 *
 * Triggered DAILY at 13:00 UTC (9:00 AM ET in summer) by an EXTERNAL scheduler
 * (cron-job.org) hitting this path with `Authorization: Bearer $CRON_SECRET`, not by
 * Vercel Cron; this route is intentionally absent from vercel.json (see
 * docs/cron-jobs.md). If that external schedule is lost on re-provision, every
 * clearance reminder is silently never sent.
 *
 * This route only ENQUEUES. Delivery is handled by the post-enqueue flush and
 * backstopped by /api/cron/email. Draining here would run concurrently with that
 * route and double-send.
 */
import { authorizeCron } from "@/platform/cron";
import { recordCronHeartbeat } from "@/platform/cron-heartbeat";
import { log, flushLogs } from "@/platform/logging";
import { runClearanceReminders } from "@/platform/email/reminders";
```

And the call on line 29 to `const r = await runClearanceReminders();`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/platform/email/reminders.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite, lint, typecheck**

Run: `npm test && npm run typecheck && npx eslint src`
Expected: PASS and clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(reminders): split the engine into HIPAA and onboarding streams"
```

---

### Task 7: Weekly per-director clearance digest

**Files:**
- Modify: `src/platform/email/templates/clearance.ts` (digest context + descriptor)
- Modify: `src/platform/email/templates/compliance.ts` (re-export `READABLE_STATUS`)
- Modify: `src/platform/email/templates/clearance.golden.test.ts`
- Modify: `src/platform/notifications/registry.ts` and `registry.test.ts`
- Modify: `src/platform/email/reminders.ts` (collect uncleared members, add `sendClearanceDigests`)
- Modify: `src/platform/email/reminders.test.ts`
- Modify: `docs/cron-jobs.md`

**Interfaces:**
- Consumes: `isoWeekKey` (Task 1), `claimReminderDispatch` from `./reminder-dispatch`, `itemsToHtml` (Task 5).
- Produces:
  - `clearanceDigestContext(p: { directorName: string; departmentNames: string; members: ClearanceDigestMember[]; reviewUrl: string }): Record<string, unknown>`
  - `ClearanceDigestMember = { name: string; departmentName: string; items: string[]; stalledDays: number | null; flagged: boolean }`
  - `ReminderRunResult` gains `digestsSent: number`
  - Notification type `clearance-digest`

- [ ] **Step 1: Write the failing tests**

Add to `src/platform/email/templates/clearance.golden.test.ts` (extend the import to include `clearanceDigestContext`):

```ts
describe("clearance-digest", () => {
  it("lists each member with their outstanding items and how long they have been stalled", async () => {
    const out = await renderEmail(
      "clearance-digest",
      clearanceDigestContext({
        directorName: "Dr. Smith",
        departmentNames: "Cardiology",
        members: [
          {
            name: "Jane Doe",
            departmentName: "Cardiology",
            items: ["HIPAA certification: expired", "Complete your assigned learning courses"],
            stalledDays: 30,
            flagged: true,
          },
          {
            name: "John Roe",
            departmentName: "Cardiology",
            items: ["Confirm your contact details in your profile"],
            stalledDays: 3,
            flagged: false,
          },
        ],
        reviewUrl: "https://hub.example.org/volunteers",
      }),
    );
    expect(out.subject).toBe("[HAVEN] 2 members are not cleared");
    expect(out.html).toContain("Jane Doe");
    expect(out.html).toContain("outstanding 30 days");
    expect(out.html).toContain("(overdue)");
    expect(out.html).toContain("John Roe");
    expect(out.html).toContain("outstanding 3 days");
  });

  it("escapes member names", async () => {
    const out = await renderEmail(
      "clearance-digest",
      clearanceDigestContext({
        directorName: "Dr. Smith",
        departmentNames: "Cardiology",
        members: [
          {
            name: '<img src=x onerror="alert(1)">',
            departmentName: "Cardiology",
            items: ["Confirm your contact details in your profile"],
            stalledDays: 1,
            flagged: false,
          },
        ],
        reviewUrl: "https://hub.example.org/volunteers",
      }),
    );
    expect(out.html).not.toContain("<img src=x");
    expect(out.html).toContain("&lt;img src=x");
  });
});
```

Add to `src/platform/email/reminders.test.ts`:

```ts
describe("weekly clearance digest", () => {
  it("sends one digest per director per ISO week across repeated daily runs", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const volunteer = await createPerson("Alice", "alice@example.com");
    const director = await createPerson("Director Bob", "bob@example.com");
    await addMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");
    await addMembership(director.id, term.id, dept.id, "DIRECTOR");
    await addCert(volunteer.id, EXPIRED_COMPLETION);
    await addCert(director.id, COMPLIANT_COMPLETION);
    await backdateMemberships(volunteer.id, LONG_AGO);
    await backdateMemberships(director.id, LONG_AGO);

    // NOW is 2026-06-01, a Monday (ISO week 2026-W23). Run every day of that week.
    for (let d = 0; d < 7; d++) {
      await runClearanceReminders(advanceNow(d));
    }
    expect(await emailLogCount("clearance-digest")).toBe(1);

    // The following Monday opens a new ISO week and a second digest.
    await runClearanceReminders(advanceNow(7));
    expect(await emailLogCount("clearance-digest")).toBe(2);
  });

  it("sends one digest covering both departments to a director of two", async () => {
    const term = await createTerm();
    const pcar = await createDepartment("PCAR");
    const jctp = await createDepartment("JCTP");
    const a = await createPerson("Alice", "alice@example.com");
    const b = await createPerson("Bella", "bella@example.com");
    const director = await createPerson("Director Bob", "bob@example.com");
    await addMembership(a.id, term.id, pcar.id, "VOLUNTEER");
    await addMembership(b.id, term.id, jctp.id, "VOLUNTEER");
    await addMembership(director.id, term.id, pcar.id, "DIRECTOR");
    await addMembership(director.id, term.id, jctp.id, "DIRECTOR");
    await addCert(a.id, EXPIRED_COMPLETION);
    await addCert(b.id, EXPIRED_COMPLETION);
    await addCert(director.id, COMPLIANT_COMPLETION);
    for (const p of [a, b, director]) await backdateMemberships(p.id, LONG_AGO);

    const result = await runClearanceReminders(NOW);

    expect(result.digestsSent).toBe(1);
    expect(await emailLogCount("clearance-digest")).toBe(1);
    const digest = await prisma.emailLog.findFirstOrThrow({
      where: { template: "clearance-digest" },
    });
    expect(digest.html).toContain("Alice");
    expect(digest.html).toContain("Bella");
  });

  it("skips a director whose departments are fully cleared", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const volunteer = await createPerson("Alice", "alice@example.com");
    const director = await createPerson("Director Bob", "bob@example.com");
    await addMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");
    await addMembership(director.id, term.id, dept.id, "DIRECTOR");
    await addCert(volunteer.id, COMPLIANT_COMPLETION);
    await addCert(director.id, COMPLIANT_COMPLETION);
    await backdateMemberships(volunteer.id, LONG_AGO);
    await backdateMemberships(director.id, LONG_AGO);

    const result = await runClearanceReminders(NOW);

    expect(result.digestsSent).toBe(0);
    expect(await emailLogCount("clearance-digest")).toBe(0);
  });

  it("includes a member no channel can reach, which is exactly who a director must chase", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    // No contactEmail and no Teams identity: unreachable under every channel.
    const volunteer = await createPerson("Ghost", null);
    const director = await createPerson("Director Bob", "bob@example.com");
    await addMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");
    await addMembership(director.id, term.id, dept.id, "DIRECTOR");
    await addCert(volunteer.id, EXPIRED_COMPLETION);
    await addCert(director.id, COMPLIANT_COMPLETION);
    await backdateMemberships(volunteer.id, LONG_AGO);
    await backdateMemberships(director.id, LONG_AGO);

    const result = await runClearanceReminders(NOW);

    expect(result.hipaaRemindersSent).toBe(0);
    expect(result.digestsSent).toBe(1);
    const digest = await prisma.emailLog.findFirstOrThrow({
      where: { template: "clearance-digest" },
    });
    expect(digest.html).toContain("Ghost");
  });
});
```

Update the `no active term` `toEqual` to include `digestsSent: 0`, and add `"clearance-digest",` to the expected key list in `src/platform/notifications/registry.test.ts`.

(The rendered body lives on `EmailLog.html`. There is no `body` column.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/platform/email/templates/clearance.golden.test.ts src/platform/email/reminders.test.ts src/platform/notifications/registry.test.ts`
Expected: FAIL, `clearanceDigestContext` is not exported and `digestsSent` is undefined.

- [ ] **Step 3: Add the digest template**

In `src/platform/email/templates/compliance.ts`, re-add and export the status map that Task 2 removed, since the digest needs a short human phrase per HIPAA status:

```ts
/** Short human phrase per HIPAA status, used in the director-facing digest. */
export const READABLE_STATUS: Record<ComplianceStatus, string> = {
  EXPIRING_SOON: "expiring soon",
  EXPIRED: "expired",
  NO_CERTIFICATE: "no certificate on file",
  UNKNOWN_DATE: "completion date needed",
  PENDING_VERIFICATION: "awaiting verification",
  COMPLIANT: "compliant",
};
```

In `src/platform/email/templates/clearance.ts`, add the param type, context builder, and descriptor:

```ts
export type ClearanceDigestMember = {
  name: string;
  departmentName: string;
  /** Outstanding items across both streams, as ready-to-display sentences. */
  items: string[];
  /** Whole days since the member first went unsatisfied. */
  stalledDays: number;
  /** True when the member has been stalled past the overdue threshold. */
  flagged: boolean;
};

export type ClearanceDigestParams = {
  directorName: string;
  /** Comma-joined names of the departments this digest covers. */
  departmentNames: string;
  /** Members not cleared, already sorted longest-stalled first. */
  members: ClearanceDigestMember[];
  /** Absolute link to the volunteers surface, which directors can open. */
  reviewUrl: string;
};

export function clearanceDigestContext(p: ClearanceDigestParams): Record<string, unknown> {
  const rows = p.members.map((m) => {
    const since = ` outstanding ${m.stalledDays} day${m.stalledDays === 1 ? "" : "s"}`;
    const flag = m.flagged ? " <strong>(overdue)</strong>" : "";
    return (
      `<li><strong>${esc(m.name)}</strong> (${esc(m.departmentName)})${since}${flag}` +
      `<ul>${itemsToHtml(m.items)}</ul></li>`
    );
  });
  const count = p.members.length;
  return {
    directorName: p.directorName,
    departmentNames: p.departmentNames,
    memberCount: count,
    memberNoun: count === 1 ? "member" : "members",
    // The subject reads "N member(s) is/are not cleared", so the verb has to agree
    // with the count as well as the noun.
    memberVerb: count === 1 ? "is" : "are",
    memberRowsHtml: rows.join(""),
    reviewUrl: p.reviewUrl,
  };
}
```

Append to `clearanceDescriptors`:

```ts
  {
    key: "clearance-digest",
    name: "Clearance: weekly digest (directors)",
    category: "transactional",
    group: "compliance",
    variables: [
      { name: "directorName", label: "Director name", sampleValue: "Dr. Smith" },
      { name: "departmentNames", label: "Comma-joined department names this digest covers", sampleValue: "Cardiology" },
      { name: "memberCount", label: "How many members are not cleared", sampleValue: "2" },
      { name: "memberNoun", label: "\"member\" or \"members\", matched to the count", sampleValue: "members" },
      { name: "memberVerb", label: "\"is\" or \"are\", matched to the count", sampleValue: "are" },
      {
        name: "memberRowsHtml",
        label: "Pre-rendered <li> rows, one per member, each with a nested list of outstanding items",
        sampleValue: "<li><strong>Jane Doe</strong> (Cardiology) outstanding 30 days<ul><li>HIPAA certification: expired</li></ul></li>",
      },
      { name: "reviewUrl", label: "Absolute link to the volunteers surface", sampleValue: "https://hub.havenfreeclinic.org/volunteers" },
    ],
    defaultSubject: "[HAVEN] {{ memberCount }} {{ memberNoun }} {{ memberVerb }} not cleared",
    defaultBody: `<p>Hello {{ directorName }},</p>

<p>{{ memberCount }} {{ memberNoun }} in {{ departmentNames }} {{ memberVerb }} not yet cleared to volunteer. Longest outstanding first:</p>

<ul>{{{ memberRowsHtml }}}</ul>

<p><a href="{{ reviewUrl }}">Open the volunteers list</a></p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
```

In `src/platform/notifications/registry.ts`, add after the `onboarding-reminder` entry:

```ts
  { key: "clearance-digest", label: "Clearance: weekly digest (directors)", defaultChannel: "email" },
```

- [ ] **Step 4: Collect uncleared members in the engine**

In `src/platform/email/reminders.ts`, add `digestsSent: number` to `ReminderRunResult` and to the initializer.

Add the imports:

```ts
import { isoWeekKey } from "@/platform/dates";
import { claimReminderDispatch } from "./reminder-dispatch";
import { READABLE_STATUS } from "./templates/compliance";
import {
  onboardingReminderContext,
  clearanceDigestContext,
  type ClearanceDigestMember,
} from "./templates/clearance";
```

Add the constant next to `ONBOARDING_REMINDER_GRACE_DAYS`:

```ts
/**
 * Days stalled before the digest flags a member as overdue. 21 is where the retired
 * threshold escalation used to fire: three reminders at the 7-day HIPAA interval.
 * Keeping that boundary is what stops a six-week holdout reading the same as someone
 * who joined on Tuesday. A constant, not a setting, because the setting it derived
 * from was removed with the escalation.
 */
const DIGEST_STALLED_FLAG_DAYS = 21;
```

Add the accumulator type above `runClearanceReminders`:

```ts
/**
 * A member the run found uncleared, carried into the weekly director digest.
 * `stalledSince` is non-nullable here: by the time a member is recorded, the row has
 * either carried a stall marker forward or just been stamped with `now`.
 */
type UnclearedMember = {
  name: string;
  items: string[];
  stalledSince: Date;
};
```

Inside `runClearanceReminders`, declare the accumulator before the loop:

```ts
  const uncleared = new Map<string, UnclearedMember>();
```

Append to the end of the per-person loop body, after the onboarding leg:

```ts
    // Record for the weekly digest. Unconditional on delivery: the digest is about
    // who is not cleared, and a member no channel could reach still belongs in it
    // (arguably belongs in it most).
    //
    // stalledSince is known without re-reading the row. Either the row already
    // carried one, or the upsert/updateMany a few lines above just stamped `now`.
    uncleared.set(person.id, {
      name: person.name,
      items: [
        ...(hipaaUnsatisfied ? [`HIPAA certification: ${READABLE_STATUS[hipaaStatus]}`] : []),
        ...items,
      ],
      stalledSince: existing?.stalledSince ?? now,
    });
```

After the loop, before the closing log call, add:

```ts
  await sendClearanceDigests(termId, uncleared, now, baseUrl, result);
```

- [ ] **Step 5: Implement the digest**

Replace the deleted `sendEscalations` slot at the bottom of `src/platform/email/reminders.ts` with:

```ts
// ---------------------------------------------------------------------------
// sendClearanceDigests (private helper)
// ---------------------------------------------------------------------------

/**
 * Queue one weekly roll-up per director covering every uncleared member in the
 * departments where they hold an ACTIVE DIRECTOR membership this term.
 *
 * The weekly cadence comes from the claim, not from a schedule: the periodKey is the
 * ISO week, so the first daily run of each week wins and the other six skip. That
 * needs no day-of-week branch, and it self-heals when a run fails, unlike a hard
 * weekly cron which would silently skip the entire week.
 *
 * Directors are resolved from TermMembership kind DIRECTOR rather than from RBAC,
 * matching the escalation this replaced. A director in several departments gets one
 * email spanning all of them, and never appears in their own digest.
 */
async function sendClearanceDigests(
  termId: string,
  uncleared: Map<string, UnclearedMember>,
  now: Date,
  baseUrl: string,
  result: ReminderRunResult
): Promise<void> {
  if (uncleared.size === 0) return;

  const memberships = await prisma.termMembership.findMany({
    where: { termId, status: "ACTIVE" },
    select: {
      personId: true,
      kind: true,
      departmentId: true,
      department: { select: { code: true, name: true } },
      person: { select: { id: true, name: true, contactEmail: true, entraObjectId: true } },
    },
    orderBy: { department: { code: "asc" } },
  });

  type DirectorPerson = { id: string; name: string; contactEmail: string | null; entraObjectId: string | null };

  const deptName = new Map<string, string>();
  const deptCode = new Map<string, string>();
  const directorById = new Map<string, DirectorPerson>();
  const deptsByDirector = new Map<string, Set<string>>();
  const rowsByDept = new Map<string, Array<{ personId: string } & ClearanceDigestMember>>();

  const flagCutoff = new Date(now.getTime() - DIGEST_STALLED_FLAG_DAYS * MS_PER_DAY);

  for (const m of memberships) {
    deptName.set(m.departmentId, m.department.name);
    deptCode.set(m.departmentId, m.department.code);

    if (m.kind === "DIRECTOR") {
      directorById.set(m.person.id, m.person);
      const set = deptsByDirector.get(m.person.id) ?? new Set<string>();
      set.add(m.departmentId);
      deptsByDirector.set(m.person.id, set);
    }

    const u = uncleared.get(m.personId);
    if (!u) continue;
    const list = rowsByDept.get(m.departmentId) ?? [];
    list.push({
      personId: m.personId,
      name: u.name,
      departmentName: m.department.name,
      items: u.items,
      stalledDays: Math.floor((now.getTime() - u.stalledSince.getTime()) / MS_PER_DAY),
      flagged: u.stalledSince < flagCutoff,
    });
    rowsByDept.set(m.departmentId, list);
  }

  const periodKey = isoWeekKey(now);

  for (const [directorId, deptIds] of deptsByDirector) {
    const director = directorById.get(directorId);
    if (!director) continue;
    if (!director.contactEmail && !director.entraObjectId) continue;

    // Dedupe members across the director's departments; first department by code wins,
    // matching how the retired escalation picked a department name.
    const ordered = [...deptIds].sort((a, b) =>
      (deptCode.get(a) ?? "").localeCompare(deptCode.get(b) ?? "")
    );
    const rows = new Map<string, ClearanceDigestMember>();
    for (const deptId of ordered) {
      for (const row of rowsByDept.get(deptId) ?? []) {
        if (row.personId === directorId) continue;
        if (!rows.has(row.personId)) rows.set(row.personId, row);
      }
    }
    if (rows.size === 0) continue;

    // Longest stalled first.
    const members = [...rows.values()].sort((a, b) => b.stalledDays - a.stalledDays);

    // Claim last, so nothing before this consumes the week's slot. A failed claim
    // means this director already got their digest for this ISO week.
    if (!(await claimReminderDispatch("clearance-digest", directorId, periodKey))) continue;

    const departmentNames = ordered
      .map((id) => deptName.get(id))
      .filter((n): n is string => Boolean(n))
      .join(", ");
    const reviewUrl = `${baseUrl}/volunteers`;

    const rendered = await renderEmail(
      "clearance-digest",
      clearanceDigestContext({
        directorName: director.name,
        departmentNames,
        members,
        reviewUrl,
      }),
    );
    await notify(prisma, {
      type: "clearance-digest",
      person: {
        id: director.id,
        entraObjectId: director.entraObjectId,
        contactEmail: director.contactEmail,
      },
      email: { subject: rendered.subject, html: rendered.html },
      teams: {
        title: "Weekly clearance digest",
        summary: `${members.length} member${members.length === 1 ? "" : "s"} in ${departmentNames} are not cleared.`,
        // /volunteers gates on volunteers.view, which the seeded Director baseline
        // holds, and it is the compliance surface itself. /admin gates on admin.access,
        // which Director does NOT hold, so linking there resolves to /no-access for
        // this notification's entire intended audience (#70).
        link: reviewUrl,
      },
    });
    result.digestsSent++;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/platform/email/templates/clearance.golden.test.ts src/platform/email/reminders.test.ts src/platform/notifications/registry.test.ts`
Expected: PASS.

- [ ] **Step 7: Update the cron documentation**

In `docs/cron-jobs.md`, replace the `/api/cron/reminders` table row with:

```
| `/api/cron/reminders` | External (cron-job.org) | daily | `0 13 * * *` | Enqueues HIPAA certificate reminders and onboarding-requirement reminders, plus the weekly per-director clearance digest (which self-paces off an ISO-week claim, so it lands on the first run of each week). | HIPAA reminders, onboarding reminders, and the weekly director digest are all never enqueued. |
```

In the Notes list, add:

```
- The weekly clearance digest rides the daily `reminders` job rather than its own
  schedule. Its periodKey is the ISO week, so the first daily run of a week sends and
  the rest skip. That means one fewer external schedule to lose on re-provision, and
  a failed Monday run is picked up on Tuesday instead of skipping the week.
```

- [ ] **Step 8: Full verification**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS and clean. Use `npx eslint src e2e` if `npm run lint` reports noise from a gitignored design-system directory.

Run: `grep -rn "runComplianceReminders\|escalationsSent\|complianceReminder\b" src e2e`
Expected: no hits.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(reminders): add the weekly per-director clearance digest"
```

---

## Post-plan verification

- [ ] `npm test` passes in full.
- [ ] `npm run typecheck` is clean.
- [ ] `npm run lint` is clean (no em-dashes anywhere).
- [ ] `npx prisma migrate status` shows the new migration applied with no drift.
- [ ] `/admin/email` lists `compliance-reminder`, `onboarding-reminder`, and `clearance-digest`, and no longer lists `compliance-escalation`.
- [ ] `/admin` Operations settings show both `Compliance reminder interval (days)` and `Onboarding reminder interval (days)`, and no longer show the escalation threshold.
