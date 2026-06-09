# Email Campaigns — Phase 2B: Scheduling + Recurrence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins schedule a campaign for a future time or on a recurring cron, dispatched automatically by the worker. Each run re-evaluates the audience against current data.

**Architecture:** The send logic from Phase 2A's `sendCampaignNow` is refactored into a shared `executeRun(campaign, { actorId, statusUpdate })` core (resolve audience → dedup → create run → render+enqueue → atomic campaign-data update). `sendCampaignNow` calls it after the typed-confirmation gate. New `scheduleCampaign` / `cancelCampaign` set schedule columns + status. A pure `dispatchDueCampaigns(now)` driver finds due one-time (`SCHEDULED`) and recurring (`ACTIVE`) campaigns, runs them via `executeRun`, and advances their schedule (one-time → `SENT`; recurring → recompute `nextRunAt`, stays `ACTIVE`). A new every-minute pg-boss `campaign-dispatch` job calls it. The editor gains a timing section.

**Tech Stack:** TypeScript, Prisma + Postgres, pg-boss v12 worker, `cron-parser` (new dep), vitest against the isolated test DB.

**Scope notes:**
- Builds directly on Phase 2A (audience engine + campaign service + send-now). Reuses the send path; does not re-implement it.
- **People only** still (Applicant audiences remain deferred until plan-10 merges).
- **Recurring semantics** (per the spec): each run re-evaluates the audience against current data; dedup is per-run; recurring intentionally re-sends each period. A run that is overdue (worker was down) fires once and advances `nextRunAt` to the next occurrence after `now` — no backfill storm.

**Environment (for the implementer):**
- Isolated DBs: dev `havenhub_emailwt`, test `havenhub_test_emailwt` (localhost:5434, haven/haven_dev). Prisma CLI auto-loads `.env` → dev DB. **vitest does not load `.env`** — run DB tests ONLY with `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailwt npx vitest run <file>`. Never a bare `npm test`.
- If a Prisma migrate step prompts to RESET the database, STOP and report BLOCKED.

---

## File Structure

**New:**
- `src/platform/email/campaigns/cron.ts` — `isValidCron(expr)`, `nextCronAfter(expr, after)` (thin wrapper over `cron-parser`, UTC)
- `src/platform/email/campaigns/cron.test.ts`
- `src/platform/email/campaigns/dispatch.ts` — `dispatchDueCampaigns(now)`
- `src/platform/email/campaigns/dispatch.test.ts`

**Modified:**
- `package.json` — add `cron-parser`
- `prisma/schema.prisma` — `EmailCampaign`: add `scheduleType`, `scheduledAt`, `cronExpr`, `lastRunAt`, `nextRunAt`; `EmailCampaignStatus`: add `SCHEDULED`, `ACTIVE`
- `src/platform/email/campaigns/service.ts` — extract `executeRun`; add `scheduleCampaign`, `cancelCampaign`; `getCampaign` includes `runs`
- `src/platform/email/campaigns/service.test.ts` — schedule/cancel tests
- `worker/index.ts` — register `campaign-dispatch` job (every minute)
- `src/app/admin/email/campaigns/[id]/page.tsx` — timing section + schedule/cancel actions + runs list

---

## Task 1: Cron utility

**Files:** `package.json`; Create `src/platform/email/campaigns/cron.ts`, `cron.test.ts`

- [ ] **Step 1: Add the dependency**

`npm install cron-parser`

Then check the installed major version and its API:
`node -e "const m=require('cron-parser'); console.log(Object.keys(m)); console.log(typeof m.parseExpression, typeof m.CronExpressionParser)"`
- cron-parser v4 exposes `parseExpression(expr, opts)`.
- cron-parser v5 exposes `CronExpressionParser.parse(expr, opts)`.
Use whichever the installed version provides (the implementation below shows v4; adapt the one call site if v5 is installed).

- [ ] **Step 2: Write the failing test**

```typescript
// src/platform/email/campaigns/cron.test.ts
import { describe, expect, it } from "vitest";
import { isValidCron, nextCronAfter } from "./cron";

describe("cron utility", () => {
  it("validates cron expressions", () => {
    expect(isValidCron("0 13 * * 1")).toBe(true);
    expect(isValidCron("not a cron")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });

  it("computes the next occurrence strictly after the given time (UTC)", () => {
    // Daily at 13:00 UTC. After 2026-06-10T12:00Z -> same day 13:00Z.
    const after = new Date("2026-06-10T12:00:00Z");
    expect(nextCronAfter("0 13 * * *", after).toISOString()).toBe("2026-06-10T13:00:00.000Z");
    // After 2026-06-10T13:00Z -> next day 13:00Z (strictly after).
    const after2 = new Date("2026-06-10T13:00:00Z");
    expect(nextCronAfter("0 13 * * *", after2).toISOString()).toBe("2026-06-11T13:00:00.000Z");
  });

  it("throws on an invalid expression in nextCronAfter", () => {
    expect(() => nextCronAfter("nope", new Date())).toThrow();
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (`npx vitest run src/platform/email/campaigns/cron.test.ts`)

- [ ] **Step 4: Implement** (v4 API shown):

```typescript
// src/platform/email/campaigns/cron.ts
import parser from "cron-parser";

export function isValidCron(expr: string): boolean {
  if (!expr || expr.trim() === "") return false;
  try {
    parser.parseExpression(expr, { tz: "UTC" });
    return true;
  } catch {
    return false;
  }
}

/** Next occurrence strictly after `after`, interpreted in UTC. Throws on a bad expression. */
export function nextCronAfter(expr: string, after: Date): Date {
  const it = parser.parseExpression(expr, { currentDate: after, tz: "UTC" });
  return it.next().toDate();
}
```

(If v5 is installed: `import { CronExpressionParser } from "cron-parser";` and `CronExpressionParser.parse(expr, { currentDate: after, tz: "UTC" })`.)

- [ ] **Step 5: Run — expect PASS**; `npx tsc --noEmit` — PASS.
- [ ] **Step 6: Commit** (`git add package.json package-lock.json src/platform/email/campaigns/cron.ts src/platform/email/campaigns/cron.test.ts && git commit -m "feat(campaigns): cron utility (validate + next occurrence)"`)

---

## Task 2: Schedule columns + status values

**Files:** `prisma/schema.prisma`

- [ ] **Step 1: Extend the enum** — add two values:

```prisma
enum EmailCampaignStatus {
  DRAFT
  SCHEDULED
  ACTIVE
  SENDING
  SENT
  CANCELLED
}
```

- [ ] **Step 2: Add schedule columns to `EmailCampaign`** (after `status`):

```prisma
  scheduleType String    @default("NOW") // NOW | SCHEDULED | RECURRING
  scheduledAt  DateTime?
  cronExpr     String?
  lastRunAt    DateTime?
  nextRunAt    DateTime?
```

- [ ] **Step 3: Migrate dev + test DBs**

`npx prisma migrate dev --name campaign_scheduling` (dev DB via .env). Then:
`DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailwt npx prisma migrate deploy`
If a reset is prompted, STOP → BLOCKED.

- [ ] **Step 4: Typecheck** `npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** (`git add prisma/schema.prisma prisma/migrations && git commit -m "feat(campaigns): campaign schedule columns + SCHEDULED/ACTIVE statuses"`)

---

## Task 3: Extract `executeRun`; add `scheduleCampaign` / `cancelCampaign`

**Files:** `src/platform/email/campaigns/service.ts`; `service.test.ts`

This refactors the existing `sendCampaignNow` to delegate to a shared `executeRun`, then adds scheduling mutations. Behavior of `sendCampaignNow` must not change (its tests must still pass).

- [ ] **Step 1: Write the failing tests** (append to `service.test.ts`)

```typescript
import { scheduleCampaign, cancelCampaign } from "./service";

describe("campaign scheduling", () => {
  it("schedules a one-time send and sets SCHEDULED + nextRunAt = scheduledAt", async () => {
    const c = await createDraft(null, "Later");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    const at = new Date("2030-01-01T12:00:00Z");
    await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: at });
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("SCHEDULED");
    expect(after.scheduledAt?.toISOString()).toBe(at.toISOString());
    expect(after.nextRunAt?.toISOString()).toBe(at.toISOString());
  });

  it("schedules a recurring send and sets ACTIVE + nextRunAt from cron", async () => {
    const c = await createDraft(null, "Weekly");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    const now = new Date("2026-06-10T12:00:00Z");
    await scheduleCampaign(null, c.id, { scheduleType: "RECURRING", cronExpr: "0 13 * * *" }, now);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.cronExpr).toBe("0 13 * * *");
    expect(after.nextRunAt?.toISOString()).toBe("2026-06-10T13:00:00.000Z");
  });

  it("rejects an invalid cron and a scheduled time/cron mismatch", async () => {
    const c = await createDraft(null, "Bad");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await expect(
      scheduleCampaign(null, c.id, { scheduleType: "RECURRING", cronExpr: "nope" }),
    ).rejects.toBeInstanceOf(CampaignValidationError);
    await expect(
      scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED" }),
    ).rejects.toBeInstanceOf(CampaignValidationError);
  });

  it("cancel sets CANCELLED", async () => {
    const c = await createDraft(null, "Stop");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: new Date("2030-01-01T00:00:00Z") });
    await cancelCampaign(null, c.id);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("CANCELLED");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Refactor + implement** in `service.ts`:

(a) Extract the shared core. Add:
```typescript
import type { Prisma } from "@prisma/client";

/**
 * Resolve the audience, dedup, create a run, render + enqueue one email per recipient,
 * and apply `statusUpdate` to the campaign — all atomically. Returns the run summary.
 * Does NOT enforce the typed-confirmation gate (callers that need it check first).
 */
export async function executeRun(
  campaignId: string,
  opts: { actorId: string | null; statusUpdate: Prisma.EmailCampaignUpdateInput },
): Promise<{ runId: string; recipientCount: number }> {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (!isAudience(campaign.audienceJson)) {
    throw new CampaignValidationError(["Stored audience is malformed"]);
  }
  const { recipients } = await resolveAudience(campaign.audienceJson);
  const seen = new Set<string>();
  const deduped = recipients.filter((r) => {
    const key = r.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const layoutSource = await loadLayoutSource();

  const runId = await prisma.$transaction(async (tx) => {
    const run = await tx.emailCampaignRun.create({
      data: { campaignId, recipientCount: deduped.length },
    });
    for (const recipient of deduped) {
      const { subject, html } = await renderInlineEmail(
        { subject: campaign.subject, body: campaign.body },
        recipient.variables,
        layoutSource,
      );
      await queueEmail(tx, {
        to: recipient.email, subject, html, template: "campaign",
        personId: recipient.recordId, triggeredById: opts.actorId, campaignRunId: run.id,
      });
    }
    await tx.emailCampaign.update({ where: { id: campaignId }, data: opts.statusUpdate });
    return run.id;
  });

  await recordAudit({
    actorPersonId: opts.actorId, action: "campaign.send",
    entityType: "EmailCampaign", entityId: campaignId,
    after: { recipientCount: deduped.length, runId },
  });
  return { runId, recipientCount: deduped.length };
}
```

(b) Rewrite `sendCampaignNow` to keep its DRAFT guard + dedup-count for the confirmation gate, then delegate. Compute the deduped count for the gate the same way (resolve once for the count, OR keep it simple by resolving inside the gate check). To avoid resolving twice, restructure: keep the resolve+dedup+gate in `sendCampaignNow`, then for the actual send call a lower-level helper. SIMPLEST correct approach: keep `sendCampaignNow`'s existing body but, where it currently does the transaction, instead it still does its own resolve for the gate and then calls `executeRun(id, { actorId, statusUpdate: { status: "SENT" } })`. Since `executeRun` re-resolves, there is a second resolve; that is acceptable (send-now is a single user action). Net `sendCampaignNow`:
```typescript
export async function sendCampaignNow(actorId, id, opts: { confirmCount?: number }) {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({ where: { id } });
  if (campaign.status !== "DRAFT") throw new Error("Campaign already sent");
  if (!isAudience(campaign.audienceJson)) throw new CampaignValidationError(["Stored audience is malformed"]);
  const { recipients } = await resolveAudience(campaign.audienceJson);
  const count = new Set(recipients.map((r) => r.email.toLowerCase())).size;
  if (count > CAMPAIGN_CONFIRM_THRESHOLD && opts.confirmCount !== count) {
    throw new CampaignConfirmationError(count);
  }
  return executeRun(id, { actorId, statusUpdate: { status: "SENT" } });
}
```
(The double-resolve is intentional for simplicity. If you prefer, factor the resolve+dedup into a private helper used by both — your call, keep behavior identical.)

(c) Add scheduling mutations:
```typescript
export type ScheduleInput =
  | { scheduleType: "SCHEDULED"; scheduledAt?: Date }
  | { scheduleType: "RECURRING"; cronExpr?: string };

export async function scheduleCampaign(
  actorId: string | null,
  id: string,
  input: ScheduleInput,
  now: Date = new Date(),
): Promise<void> {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({ where: { id } });
  if (campaign.status !== "DRAFT") throw new Error("Only a draft can be scheduled");

  if (input.scheduleType === "SCHEDULED") {
    if (!input.scheduledAt) throw new CampaignValidationError(["A send time is required"]);
    await prisma.emailCampaign.update({
      where: { id },
      data: { scheduleType: "SCHEDULED", scheduledAt: input.scheduledAt, cronExpr: null,
        nextRunAt: input.scheduledAt, status: "SCHEDULED" },
    });
  } else {
    if (!input.cronExpr || !isValidCron(input.cronExpr)) {
      throw new CampaignValidationError(["A valid cron expression is required"]);
    }
    await prisma.emailCampaign.update({
      where: { id },
      data: { scheduleType: "RECURRING", cronExpr: input.cronExpr, scheduledAt: null,
        nextRunAt: nextCronAfter(input.cronExpr, now), status: "ACTIVE" },
    });
  }
  await recordAudit({ actorPersonId: actorId, action: "campaign.schedule", entityType: "EmailCampaign", entityId: id, after: { scheduleType: input.scheduleType } });
}

export async function cancelCampaign(actorId: string | null, id: string): Promise<void> {
  await prisma.emailCampaign.update({ where: { id }, data: { status: "CANCELLED", nextRunAt: null } });
  await recordAudit({ actorPersonId: actorId, action: "campaign.cancel", entityType: "EmailCampaign", entityId: id });
}
```
Import `isValidCron`, `nextCronAfter` from `./cron`.

(d) Update `getCampaign` to include runs (most recent first):
```typescript
export async function getCampaign(id: string) {
  return prisma.emailCampaign.findUnique({ where: { id }, include: { runs: { orderBy: { runAt: "desc" } } } });
}
```

- [ ] **Step 4: Run — expect PASS** (the whole `service.test.ts`, including the pre-existing send-now + immutability tests):
`TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailwt npx vitest run src/platform/email/campaigns/service.test.ts`
Then `npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** (`git commit -m "feat(campaigns): executeRun core + schedule/cancel mutations"`)

---

## Task 4: `dispatchDueCampaigns(now)`

**Files:** Create `src/platform/email/campaigns/dispatch.ts`, `dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/platform/email/campaigns/dispatch.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createDraft, updateCampaign, scheduleCampaign } from "./service";
import { dispatchDueCampaigns } from "./dispatch";

beforeEach(resetDb);

const ALL_ACTIVE = { recordType: "PERSON" as const, match: "ALL" as const, conditions: [{ field: "status", op: "eq" as const, value: "ACTIVE" }] };

async function readyCampaign(name: string) {
  const c = await createDraft(null, name);
  await updateCampaign(null, c.id, { subject: "Hi {{ firstName }}", body: "<p>Hi {{ firstName }}</p>", audience: ALL_ACTIVE });
  return c;
}

describe("dispatchDueCampaigns", () => {
  it("runs a due one-time campaign once and marks it SENT", async () => {
    await prisma.person.create({ data: { name: "Sam Rivera", contactEmail: "sam@example.com", status: "ACTIVE" } });
    const c = await readyCampaign("OneTime");
    await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: new Date("2026-06-10T12:00:00Z") });

    // Not due yet
    let summary = await dispatchDueCampaigns(new Date("2026-06-10T11:59:00Z"));
    expect(summary.executed).toBe(0);

    // Due now
    summary = await dispatchDueCampaigns(new Date("2026-06-10T12:00:30Z"));
    expect(summary.executed).toBe(1);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("SENT");
    expect(after.lastRunAt).not.toBeNull();
    const logs = await prisma.emailLog.findMany({ where: { template: "campaign" } });
    expect(logs.length).toBe(1);

    // Does not run again
    summary = await dispatchDueCampaigns(new Date("2026-06-10T13:00:00Z"));
    expect(summary.executed).toBe(0);
  });

  it("runs a recurring campaign and advances nextRunAt, staying ACTIVE", async () => {
    await prisma.person.create({ data: { name: "Sam Rivera", contactEmail: "sam@example.com", status: "ACTIVE" } });
    const c = await readyCampaign("Daily");
    await scheduleCampaign(null, c.id, { scheduleType: "RECURRING", cronExpr: "0 13 * * *" }, new Date("2026-06-10T12:00:00Z"));
    // nextRunAt is 2026-06-10T13:00Z

    const summary = await dispatchDueCampaigns(new Date("2026-06-10T13:00:30Z"));
    expect(summary.executed).toBe(1);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.nextRunAt?.toISOString()).toBe("2026-06-11T13:00:00.000Z");
    const runs = await prisma.emailCampaignRun.findMany({ where: { campaignId: c.id } });
    expect(runs.length).toBe(1);
  });

  it("skips CANCELLED campaigns", async () => {
    const c = await readyCampaign("Stopped");
    await scheduleCampaign(null, c.id, { scheduleType: "SCHEDULED", scheduledAt: new Date("2026-06-10T12:00:00Z") });
    await prisma.emailCampaign.update({ where: { id: c.id }, data: { status: "CANCELLED" } });
    const summary = await dispatchDueCampaigns(new Date("2026-06-10T12:01:00Z"));
    expect(summary.executed).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```typescript
// src/platform/email/campaigns/dispatch.ts
import { prisma } from "@/platform/db";
import { executeRun } from "./service";
import { nextCronAfter } from "./cron";

export type DispatchSummary = { executed: number; errors: number };

/** Find due scheduled/recurring campaigns and run them. Idempotent per (campaign, due time). */
export async function dispatchDueCampaigns(now: Date): Promise<DispatchSummary> {
  const due = await prisma.emailCampaign.findMany({
    where: {
      status: { in: ["SCHEDULED", "ACTIVE"] },
      nextRunAt: { not: null, lte: now },
    },
  });

  let executed = 0;
  let errors = 0;
  for (const campaign of due) {
    try {
      if (campaign.status === "SCHEDULED") {
        await executeRun(campaign.id, { actorId: null, statusUpdate: { status: "SENT", lastRunAt: now, nextRunAt: null } });
      } else {
        // ACTIVE / recurring — re-evaluate audience each run, advance the schedule.
        const next = campaign.cronExpr ? nextCronAfter(campaign.cronExpr, now) : null;
        await executeRun(campaign.id, { actorId: null, statusUpdate: { lastRunAt: now, nextRunAt: next } });
      }
      executed++;
    } catch (err) {
      errors++;
      console.error("[campaign-dispatch] run failed", campaign.id, err);
    }
  }
  return { executed, errors };
}
```

- [ ] **Step 4: Run — expect PASS**; `npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** (`git commit -m "feat(campaigns): dispatchDueCampaigns driver for scheduled + recurring sends"`)

---

## Task 5: Worker job

**Files:** `worker/index.ts`

Follow the existing pg-boss pattern (queue const → `createQueue` → `schedule` → `work`).

- [ ] **Step 1: Add the queue + schedule + handler**

- Add a constant near the other queue names: `const CAMPAIGN_DISPATCH_QUEUE = "campaign-dispatch";`
- Add `await boss.createQueue(CAMPAIGN_DISPATCH_QUEUE);` with the others.
- Add `await boss.schedule(CAMPAIGN_DISPATCH_QUEUE, "* * * * *");` (every minute) with the others.
- Add the handler with the others:
```typescript
await boss.work(CAMPAIGN_DISPATCH_QUEUE, async () => {
  const r = await dispatchDueCampaigns(new Date());
  if (r.executed > 0 || r.errors > 0) {
    console.log(`[worker] campaign dispatch executed=${r.executed} errors=${r.errors}`);
  }
});
```
- Add the import at the top: `import { dispatchDueCampaigns } from "../src/platform/email/campaigns/dispatch";` (match the existing relative-import style used for other services in `worker/index.ts`).

- [ ] **Step 2: Typecheck** `npx tsc --noEmit` — PASS. (The worker is not unit-tested; `dispatchDueCampaigns` is covered by Task 4.)
- [ ] **Step 3: Commit** (`git commit -m "feat(campaigns): every-minute campaign-dispatch worker job"`)

---

## Task 6: Timing UI + runs list

**Files:** `src/app/admin/email/campaigns/[id]/page.tsx` (and a small client helper if needed)

Add to the campaign editor, following the existing server-action conventions (gated by `admin.send_email_campaign`, error via `searchParams`). Manual verification.

- [ ] **Step 1: Timing section + actions**
- A "Timing" section with three choices (radio): **Send manually** (default — the existing Send-now controls), **Schedule for later**, **Recurring**.
  - Schedule for later: a `<input type="datetime-local" name="scheduledAt">` + a "Schedule" button → `scheduleLaterAction`: parse the value to a `Date` (`new Date(value)`), call `scheduleCampaign(actor.personId, id, { scheduleType: "SCHEDULED", scheduledAt })`. Catch `CampaignValidationError`/`Error` → error redirect.
  - Recurring: a `<input name="cronExpr" placeholder="0 13 * * 1">` + helper text ("min hour day month weekday, in UTC; e.g. `0 13 * * 1` = Mondays 13:00 UTC") + a "Start recurring" button → `scheduleRecurringAction`: `scheduleCampaign(actor.personId, id, { scheduleType: "RECURRING", cronExpr })`. Catch validation error → error redirect prompting for a valid cron.
- When `campaign.status` is `SCHEDULED` or `ACTIVE`: show a status banner (e.g. "Scheduled for <scheduledAt>" or "Recurring (<cronExpr>) — next run <nextRunAt>") and a **Cancel schedule** button → `cancelAction` → `cancelCampaign(...)`. Hide the compose/audience edit forms when not a DRAFT (already done for SENT; extend to SCHEDULED/ACTIVE — those are read-only too, since `updateCampaign`/`scheduleCampaign` require DRAFT). Cancel returns it toward a stopped state (CANCELLED).
- Only show the timing/schedule controls when the campaign is a DRAFT.

- [ ] **Step 2: Past runs list**
- `getCampaign` now includes `runs`. Render a "Sent runs" table: runAt + recipientCount, most recent first. Show for any campaign that has runs.

- [ ] **Step 3: Typecheck + lint** — `npx tsc --noEmit`, `npm run lint` — PASS.

- [ ] **Step 4: Manual verification** — as a holder of `admin.send_email_campaign`: create + compose + set an audience; schedule it for ~2 minutes out; confirm the status banner shows SCHEDULED with the time; with the worker running (`npm run worker`), confirm a run appears and status flips to SENT (or for a recurring `* * * * *` test cron, confirm runs accrue and `nextRunAt` advances). Confirm Cancel stops it.

- [ ] **Step 5: Commit** (`git commit -m "feat(campaigns): scheduling UI (schedule/recurring/cancel) + runs list"`)

---

## Task 7: Full-suite verification

- [ ] **Step 1:** `npx tsc --noEmit` — PASS.
- [ ] **Step 2:** `npm run lint` — PASS.
- [ ] **Step 3:** Full suite — `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailwt npx vitest run` — PASS.
- [ ] **Step 4:** Tick boxes; commit (`git commit -m "docs(campaigns): mark phase 2B plan complete"`).

---

## Self-Review (completed during planning)

**Spec coverage (Phase 2B):** send-now + scheduled (one-time) + recurring (cron) (Tasks 2–5) ✓; new `campaign-dispatch` worker job every minute (Task 5) ✓; re-evaluate audience against current data each run (executeRun re-resolves; Task 3) ✓; per-run dedup (reused from 2A; executeRun) ✓; recurring re-sends each period, no backfill storm (dispatch advances `nextRunAt` to next-after-now; Task 4) ✓; tracks `lastRunAt`/`nextRunAt` (Tasks 3–4) ✓; timing UI + runs view + cancel (Task 6) ✓. **Still deferred:** Applicant audiences (plan-10).

**Type consistency:** `executeRun(campaignId, { actorId, statusUpdate: Prisma.EmailCampaignUpdateInput })` is the single send core, called by `sendCampaignNow` (Task 3) and `dispatchDueCampaigns` (Task 4). `scheduleCampaign(actorId, id, ScheduleInput, now?)` and `nextCronAfter`/`isValidCron` (Task 1) are consumed by the dispatcher and the UI actions (Task 6). Status lifecycle: DRAFT → (SCHEDULED | ACTIVE) → SENT (one-time) or stays ACTIVE (recurring) → CANCELLED.

**Determinism:** every time-dependent function (`dispatchDueCampaigns`, `scheduleCampaign`, `nextCronAfter`) takes an explicit `now`/`after`, so tests control the clock; the worker passes `new Date()`.
