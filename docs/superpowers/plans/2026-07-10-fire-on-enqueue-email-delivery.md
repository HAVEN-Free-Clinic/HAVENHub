# Fire-on-enqueue Email & Teams Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver queued email and Teams DMs on enqueue (in ~1s, after the response commits) instead of polling a queue every minute, keeping a slow cron only as a retry/campaign backstop.

**Architecture:** Both enqueue chokepoints (`queueEmail`, `queueTeamsMessage`) schedule a post-response drain via Next 16 `after()`. A shared coalescing helper collapses a burst of enqueues into a single drain pass. A one-line retry gate keeps a failed row locked for the existing 5-minute stale window so enqueue-triggered drains cannot burn the retry budget. The `/api/cron/email` route is unchanged in code and its external schedule slows from every minute to every 30 minutes.

**Tech Stack:** TypeScript, Next.js 16 App Router (`after` from `next/server`), Prisma, Vitest (integration tests against a local Postgres test DB).

## Global Constraints

- **No em-dash character (U+2014) anywhere in `src/`.** The `local/no-em-dash` ESLint rule fails the build on it. Use a comma, colon, parentheses, or hyphen. Apply the same rule to the Markdown docs in this change (author preference), even though eslint does not scan them.
- **`after()` throws outside a request scope.** It is verified to throw `"after() was called outside a request scope"` in plain Node / vitest. Every `after()` call MUST be wrapped in try/catch so seed scripts and unit tests no-op safely.
- **Never wrap a queue drain in a `while (processed > 0)` loop** (issue #63: a whole-tick transport outage would burn all 8 retries). The only permitted loop is the coalescing `while (dirty)` loop in Task 1, which re-runs solely when genuinely new work was enqueued mid-drain.
- **Drains are concurrency-safe** via the existing atomic `updateMany` claim on `lockedAt`; multiple concurrent drainers (enqueue-triggered plus cron) are therefore allowed and cannot double-send.
- **Path alias:** `@/` resolves to `src/`.
- **Tests are integration tests against a local Postgres test DB.** Bring it up with `docker compose up -d postgres`; vitest defaults to `postgresql://haven:haven_dev@localhost:5434/havenhub_test` (or set `TEST_DATABASE_URL` to a per-worktree DB). NEVER point tests at the Neon URL in `.env`. Run the schema onto the test DB once before testing: `DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test npx prisma migrate deploy`.
- **Retry backoff is the existing `STALE_LOCK_MS = 5 * 60 * 1000`** (5 minutes), reused, not a new column.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/platform/flush-on-enqueue.ts` | **New leaf util.** `createEnqueueFlusher(drain)` returns `{ flushNow, schedule }`: coalesced drain + post-response scheduling. Imports only `after` from `next/server`, so it adds no import cycle. |
| `src/platform/flush-on-enqueue.test.ts` | **New.** Unit tests for coalescing and the request-scope guard (no DB). |
| `src/platform/email/send.ts` | Add email flusher + `flushEmailQueue`; call `schedule()` in `queueEmail`; retry gate in `drainEmailQueue` catch. |
| `src/platform/email/send.flush.test.ts` | **New.** Integration tests: retry gate + fire-on-enqueue wiring for email. |
| `src/platform/notifications/send.ts` | Add Teams flusher + `flushTeamsQueue`; call `schedule()` in `queueTeamsMessage`; retry gate in `drainTeamsQueue` transient branch. |
| `src/platform/notifications/send.flush.test.ts` | **New.** Integration tests: retry gate + fire-on-enqueue wiring for Teams. |
| `src/app/api/cron/email/route.ts` | Header comment rewrite only (30-minute backstop, enqueue-triggered primary delivery). |
| `docs/cron-jobs.md` | Update the `/api/cron/email` row and notes. |

---

### Task 1: Shared coalescing flusher

**Files:**
- Create: `src/platform/flush-on-enqueue.ts`
- Test: `src/platform/flush-on-enqueue.test.ts`

**Interfaces:**
- Produces: `createEnqueueFlusher(drain: () => Promise<void>): { flushNow: () => Promise<void>; schedule: () => void }`

- [ ] **Step 1: Write the failing test**

Create `src/platform/flush-on-enqueue.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createEnqueueFlusher } from "./flush-on-enqueue";

describe("createEnqueueFlusher", () => {
  it("runs one drain per non-overlapping flush", async () => {
    let calls = 0;
    const { flushNow } = createEnqueueFlusher(async () => {
      calls++;
    });
    await flushNow();
    await flushNow();
    expect(calls).toBe(2);
  });

  it("collapses flushes that arrive during an in-flight drain into one re-run", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const drain = async () => {
      calls++;
      if (calls === 1) await gate; // park only the first drain
    };
    const { flushNow } = createEnqueueFlusher(drain);

    const a = flushNow(); // calls=1, parks on gate
    const b = flushNow(); // drain in flight -> marks dirty, returns
    const c = flushNow(); // still dirty, returns
    release(); // first drain completes -> loop sees dirty -> one more drain (calls=2)
    await Promise.all([a, b, c]);

    expect(calls).toBe(2);
  });

  it("schedule() does not throw outside a request scope", () => {
    const { schedule } = createEnqueueFlusher(async () => {});
    expect(() => schedule()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/flush-on-enqueue.test.ts`
Expected: FAIL, cannot resolve `./flush-on-enqueue`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/flush-on-enqueue.ts`:

```ts
import { after } from "next/server";

/**
 * Wrap a drain function so it fires once per request, after the HTTP response
 * commits. Returns:
 *  - flushNow(): run the drain, coalescing overlapping calls. A burst of
 *    enqueues in one request collapses to a single drain pass; if new work is
 *    enqueued during a drain, exactly one more pass runs. This while(dirty) loop
 *    is NOT the forbidden while(processed > 0) loop of issue #63: it re-runs only
 *    when a genuinely new row was enqueued mid-drain (dirty set by another
 *    flushNow call), never to re-hammer a failed row.
 *  - schedule(): register flushNow() to run after the response (post-commit, so
 *    it sees this request's just-written rows). No-ops outside a request scope
 *    (seed scripts, unit tests), where the safety-net cron drains instead.
 *
 * State is per module instance: concurrent requests on one serverless instance
 * coalesce onto a single drain; separate instances drain independently, which is
 * safe because the drains claim each row atomically (no double-send).
 */
export function createEnqueueFlusher(drain: () => Promise<void>): {
  flushNow: () => Promise<void>;
  schedule: () => void;
} {
  let draining = false;
  let dirty = false;

  async function flushNow(): Promise<void> {
    dirty = true;
    if (draining) return; // a drain is already running; it will pick up `dirty`
    draining = true;
    try {
      while (dirty) {
        dirty = false;
        await drain();
      }
    } finally {
      draining = false;
    }
  }

  function schedule(): void {
    try {
      after(() => flushNow());
    } catch {
      // Outside a request scope (script / unit test): the safety-net cron drains.
    }
  }

  return { flushNow, schedule };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/flush-on-enqueue.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/flush-on-enqueue.ts src/platform/flush-on-enqueue.test.ts
git commit -m "feat(email): add coalescing enqueue-flush helper"
```

---

### Task 2: Email retry gate

Keep a failed email row locked on failure so a second drain within the 5-minute stale window does not re-attempt it. This decouples retry cadence from trigger frequency (required before enqueues can trigger drains).

**Files:**
- Modify: `src/platform/email/send.ts` (the `catch` block inside `drainEmailQueue`, around line 131-144)
- Test: `src/platform/email/send.flush.test.ts` (new)

**Interfaces:**
- Consumes: existing `drainEmailQueue(transport, batchSize?)`, `EmailTransport` from `./transport`.

- [ ] **Step 1: Write the failing test**

Create `src/platform/email/send.flush.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { drainEmailQueue } from "@/platform/email/send";
import type { EmailTransport } from "@/platform/email/transport";

const failing: EmailTransport = {
  send: async () => {
    throw new Error("graph down");
  },
};

async function seedQueued(): Promise<string> {
  const row = await prisma.emailLog.create({
    data: { toEmail: "x@example.com", subject: "s", html: "<p>x</p>", template: "generic" },
  });
  return row.id;
}

describe("drainEmailQueue retry gate", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("keeps a failed row locked and does not re-attempt it within the stale window", async () => {
    const id = await seedQueued();

    await drainEmailQueue(failing);
    const first = await prisma.emailLog.findUniqueOrThrow({ where: { id } });
    expect(first.status).toBe("QUEUED");
    expect(first.attempts).toBe(1);
    expect(first.lockedAt).not.toBeNull(); // gate: lock retained on failure

    // Immediate second drain: the fresh lock makes the row unclaimable.
    await drainEmailQueue(failing);
    const second = await prisma.emailLog.findUniqueOrThrow({ where: { id } });
    expect(second.attempts).toBe(1);

    // Age the lock past the 5-minute stale window; the row becomes retryable.
    await prisma.emailLog.update({
      where: { id },
      data: { lockedAt: new Date(Date.now() - 6 * 60 * 1000) },
    });
    await drainEmailQueue(failing);
    const third = await prisma.emailLog.findUniqueOrThrow({ where: { id } });
    expect(third.attempts).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/email/send.flush.test.ts`
Expected: FAIL at `expect(first.lockedAt).not.toBeNull()` (current code sets `lockedAt: null`, and the immediate second drain bumps attempts to 2).

- [ ] **Step 3: Make the change**

In `src/platform/email/send.ts`, inside `drainEmailQueue`'s `catch` block, change the `lockedAt` line and its comment. Replace:

```ts
            status: attempts >= MAX_ATTEMPTS ? "FAILED" : "QUEUED",
            // Release the claim so the row is retryable on the next tick (it sits
            // behind this invocation's cursor, so it is not re-attempted now).
            lockedAt: null,
```

with:

```ts
            status: attempts >= MAX_ATTEMPTS ? "FAILED" : "QUEUED",
            // Keep the claim (do NOT null lockedAt): a failed row stays locked so
            // its retry is gated by the STALE_LOCK_MS window, not by how often a
            // drain is triggered. Since delivery now fires on enqueue, an enqueue
            // burst during an outage must not re-attempt this row until the lock
            // goes stale, or it would burn all retries in seconds (issue #63). On
            // FAILED the value is moot (FAILED rows are never re-claimed).
            lockedAt: claimedAt,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/email/send.flush.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the issue #63 regression test still passes**

Run: `npx vitest run src/app/api/cron/email/route.outage.test.ts`
Expected: PASS (a single GET still leaves each row `QUEUED` with `attempts === 1`; the change only affects re-attempts across separate drains).

- [ ] **Step 6: Commit**

```bash
git add src/platform/email/send.ts src/platform/email/send.flush.test.ts
git commit -m "fix(email): gate failed-send retries by the stale-lock window"
```

---

### Task 3: Email fire-on-enqueue wiring

Add the email flusher and call `schedule()` from `queueEmail`.

**Files:**
- Modify: `src/platform/email/send.ts`
- Test: `src/platform/email/send.flush.test.ts` (extend)

**Interfaces:**
- Consumes: `createEnqueueFlusher` (Task 1), `resolveEmailTransport` from `./transport`, existing `drainEmailQueue`.
- Produces: `flushEmailQueue(): Promise<void>` (exported); `queueEmail` now schedules a post-response drain.

- [ ] **Step 1: Write the failing test**

First, update the existing top-of-file import in `src/platform/email/send.flush.test.ts` from:

```ts
import { drainEmailQueue } from "@/platform/email/send";
```

to:

```ts
import { drainEmailQueue, queueEmail, flushEmailQueue } from "@/platform/email/send";
```

Then append this describe block to the same file (no new import line):

```ts
describe("email fire-on-enqueue wiring", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("queueEmail does not deliver synchronously outside a request scope", async () => {
    await queueEmail(prisma, {
      to: "q@example.com",
      subject: "s",
      html: "<p>q</p>",
      template: "generic",
    });
    const row = await prisma.emailLog.findFirstOrThrow({ where: { toEmail: "q@example.com" } });
    expect(row.status).toBe("QUEUED");
  });

  it("flushEmailQueue delivers a queued email via the resolved transport", async () => {
    await queueEmail(prisma, {
      to: "n@example.com",
      subject: "s",
      html: "<p>n</p>",
      template: "generic",
    });
    await flushEmailQueue();
    const row = await prisma.emailLog.findFirstOrThrow({ where: { toEmail: "n@example.com" } });
    expect(row.status).toBe("SENT");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/email/send.flush.test.ts`
Expected: FAIL, `flushEmailQueue` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/platform/email/send.ts`:

3a. Add the flusher import near the top, and fold `resolveEmailTransport` into the existing `./transport` import. Change the existing line 3:

```ts
import type { EmailTransport } from "./transport";
```

to:

```ts
import { resolveEmailTransport, type EmailTransport } from "./transport";
```

and add this new import alongside the other top imports:

```ts
import { createEnqueueFlusher } from "@/platform/flush-on-enqueue";
```

3b. Immediately after the `STALE_LOCK_MS` constant, add the flusher (it references `drainEmailQueue`, a hoisted function declaration defined below, and is only invoked at call time):

```ts
const emailFlusher = createEnqueueFlusher(async () => {
  const transport = await resolveEmailTransport();
  await drainEmailQueue(transport);
});

/** Run the email drain now, coalescing overlapping calls. Exposed for the cron
 *  route and tests; delivery is normally triggered via queueEmail on enqueue. */
export const flushEmailQueue = emailFlusher.flushNow;
```

3c. In `queueEmail`, capture the created row, schedule a flush, and return it. Replace:

```ts
  const sender = await resolveSenderForTemplate(input.template);
  return db.emailLog.create({
    data: {
      toEmail: input.to,
      subject: input.subject,
      html: input.html,
      template: input.template,
      personId: input.personId ?? null,
      triggeredById: input.triggeredById ?? null,
      campaignRunId: input.campaignRunId ?? null,
      fromEmail: sender?.fromEmail ?? null,
      fromName: sender?.fromName ?? null,
    },
  });
```

with:

```ts
  const sender = await resolveSenderForTemplate(input.template);
  const row = await db.emailLog.create({
    data: {
      toEmail: input.to,
      subject: input.subject,
      html: input.html,
      template: input.template,
      personId: input.personId ?? null,
      triggeredById: input.triggeredById ?? null,
      campaignRunId: input.campaignRunId ?? null,
      fromEmail: sender?.fromEmail ?? null,
      fromName: sender?.fromName ?? null,
    },
  });
  // Deliver on enqueue: after the response commits (post-transaction, so this row
  // is visible), drain the queue so the message goes out in ~1s instead of
  // waiting for the safety-net cron. No-ops outside a request scope.
  emailFlusher.schedule();
  return row;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/email/send.flush.test.ts`
Expected: PASS (all email flush tests).

- [ ] **Step 5: Confirm existing email tests still pass**

Run: `npx vitest run src/app/api/cron/email/route.test.ts`
Expected: PASS (queueEmail's `schedule()` no-ops in these direct-handler tests; the route's inline drain still delivers).

- [ ] **Step 6: Commit**

```bash
git add src/platform/email/send.ts src/platform/email/send.flush.test.ts
git commit -m "feat(email): deliver on enqueue via post-response flush"
```

---

### Task 4: Teams retry gate

Mirror Task 2 for the Teams queue's transient-failure branch.

**Files:**
- Modify: `src/platform/notifications/send.ts` (the `else` branch inside `drainTeamsQueue`'s `catch`, around line 174-181)
- Test: `src/platform/notifications/send.flush.test.ts` (new)

**Interfaces:**
- Consumes: existing `drainTeamsQueue(transport, batchSize?)`, `TeamsTransport` from `./teams-transport`.

- [ ] **Step 1: Write the failing test**

Create `src/platform/notifications/send.flush.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { drainTeamsQueue } from "@/platform/notifications/send";
import type { TeamsTransport } from "@/platform/notifications/teams-transport";

const failing: TeamsTransport = {
  send: async () => {
    throw new Error("graph down");
  },
};

async function seedQueued(): Promise<string> {
  const person = await prisma.person.create({
    data: { name: "T", status: "ACTIVE", entraObjectId: "entra-1", contactEmail: "t@example.com" },
  });
  const row = await prisma.teamsMessage.create({
    data: {
      personId: person.id,
      type: "generic",
      title: "t",
      summary: "s",
      bodyHtml: "<p>b</p>",
      fallbackSubject: "fs",
      fallbackHtml: "<p>fb</p>",
    },
  });
  return row.id;
}

describe("drainTeamsQueue retry gate", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("keeps a failed row locked and does not re-attempt it within the stale window", async () => {
    const id = await seedQueued();

    await drainTeamsQueue(failing);
    const first = await prisma.teamsMessage.findUniqueOrThrow({ where: { id } });
    expect(first.status).toBe("QUEUED");
    expect(first.attempts).toBe(1);
    expect(first.lockedAt).not.toBeNull();

    await drainTeamsQueue(failing);
    const second = await prisma.teamsMessage.findUniqueOrThrow({ where: { id } });
    expect(second.attempts).toBe(1);

    await prisma.teamsMessage.update({
      where: { id },
      data: { lockedAt: new Date(Date.now() - 6 * 60 * 1000) },
    });
    await drainTeamsQueue(failing);
    const third = await prisma.teamsMessage.findUniqueOrThrow({ where: { id } });
    expect(third.attempts).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/notifications/send.flush.test.ts`
Expected: FAIL at `expect(first.lockedAt).not.toBeNull()`.

- [ ] **Step 3: Make the change**

In `src/platform/notifications/send.ts`, inside `drainTeamsQueue`'s `catch` block, the `else` (transient) branch. Replace:

```ts
        } else {
          await prisma.teamsMessage.update({
            where: { id: row.id },
            // Release the claim so the row is retryable on the next tick (it sits
            // behind this invocation's cursor, so it is not re-attempted now).
            data: { attempts, lastError: message, status: "QUEUED", lockedAt: null },
          });
        }
```

with:

```ts
        } else {
          await prisma.teamsMessage.update({
            where: { id: row.id },
            // Keep the claim (do NOT null lockedAt): a failed row stays locked so
            // its retry is gated by the STALE_LOCK_MS window, not by how often a
            // drain is triggered. Delivery now fires on enqueue, so an enqueue
            // burst during an outage must not re-attempt this row until the lock
            // goes stale (mirrors drainEmailQueue; issue #63).
            data: { attempts, lastError: message, status: "QUEUED", lockedAt: claimedAt },
          });
        }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/notifications/send.flush.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/notifications/send.ts src/platform/notifications/send.flush.test.ts
git commit -m "fix(teams): gate failed-send retries by the stale-lock window"
```

---

### Task 5: Teams fire-on-enqueue wiring

Add the Teams flusher and call `schedule()` from `queueTeamsMessage`.

**Files:**
- Modify: `src/platform/notifications/send.ts`
- Test: `src/platform/notifications/send.flush.test.ts` (extend)

**Interfaces:**
- Consumes: `createEnqueueFlusher` (Task 1), `resolveTeamsTransport` from `./teams-transport`, existing `drainTeamsQueue`, `queueTeamsMessage`.
- Produces: `flushTeamsQueue(): Promise<void>` (exported); `queueTeamsMessage` now schedules a post-response drain.

- [ ] **Step 1: Write the failing test**

First, update the existing top-of-file import in `src/platform/notifications/send.flush.test.ts` from:

```ts
import { drainTeamsQueue } from "@/platform/notifications/send";
```

to:

```ts
import { drainTeamsQueue, queueTeamsMessage, flushTeamsQueue } from "@/platform/notifications/send";
```

Then append this to the same file (no new import line):

```ts
async function seedPerson(): Promise<string> {
  const person = await prisma.person.create({
    data: { name: "T2", status: "ACTIVE", entraObjectId: "entra-2", contactEmail: "t2@example.com" },
  });
  return person.id;
}

const teamsInput = (personId: string) => ({
  personId,
  type: "generic",
  title: "t",
  summary: "s",
  bodyHtml: "<p>b</p>",
  fallbackSubject: "fs",
  fallbackHtml: "<p>fb</p>",
});

describe("teams fire-on-enqueue wiring", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("queueTeamsMessage does not deliver synchronously outside a request scope", async () => {
    const personId = await seedPerson();
    await queueTeamsMessage(prisma, teamsInput(personId));
    const row = await prisma.teamsMessage.findFirstOrThrow({ where: { personId } });
    expect(row.status).toBe("QUEUED");
  });

  it("flushTeamsQueue drains a queued message via the resolved transport", async () => {
    const personId = await seedPerson();
    await queueTeamsMessage(prisma, teamsInput(personId));
    await flushTeamsQueue();
    const row = await prisma.teamsMessage.findFirstOrThrow({ where: { personId } });
    // The log transport (EMAIL_TRANSPORT=log in tests) records LOGGED, not SENT.
    expect(row.status).toBe("LOGGED");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/notifications/send.flush.test.ts`
Expected: FAIL, `flushTeamsQueue` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/platform/notifications/send.ts`:

3a. Add the flusher import near the top, and fold `resolveTeamsTransport` into the existing `./teams-transport` import. Change the existing line 4:

```ts
import type { TeamsTransport } from "./teams-transport";
```

to:

```ts
import { resolveTeamsTransport, type TeamsTransport } from "./teams-transport";
```

and add this new import alongside the other top imports:

```ts
import { createEnqueueFlusher } from "@/platform/flush-on-enqueue";
```

3b. Immediately after the `STALE_LOCK_MS` constant, add the flusher:

```ts
const teamsFlusher = createEnqueueFlusher(async () => {
  const transport = await resolveTeamsTransport();
  await drainTeamsQueue(transport);
});

/** Run the Teams drain now, coalescing overlapping calls. Exposed for the cron
 *  route and tests; delivery is normally triggered via queueTeamsMessage. */
export const flushTeamsQueue = teamsFlusher.flushNow;
```

3c. In `queueTeamsMessage`, capture the row, schedule a flush, and return it. Replace:

```ts
export async function queueTeamsMessage(db: Db, input: QueueTeamsInput): Promise<TeamsMessage> {
  return db.teamsMessage.create({
    data: {
      personId: input.personId,
      type: input.type,
      title: input.title,
      summary: input.summary,
      link: input.link ?? null,
      bodyHtml: input.bodyHtml,
      fallbackSubject: input.fallbackSubject,
      fallbackHtml: input.fallbackHtml,
      emailAlreadyQueued: input.emailAlreadyQueued ?? false,
    },
  });
}
```

with:

```ts
export async function queueTeamsMessage(db: Db, input: QueueTeamsInput): Promise<TeamsMessage> {
  const row = await db.teamsMessage.create({
    data: {
      personId: input.personId,
      type: input.type,
      title: input.title,
      summary: input.summary,
      link: input.link ?? null,
      bodyHtml: input.bodyHtml,
      fallbackSubject: input.fallbackSubject,
      fallbackHtml: input.fallbackHtml,
      emailAlreadyQueued: input.emailAlreadyQueued ?? false,
    },
  });
  // Deliver on enqueue: after the response commits, drain so the DM goes out in
  // ~1s instead of waiting for the safety-net cron. No-ops outside a request scope.
  teamsFlusher.schedule();
  return row;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/notifications/send.flush.test.ts`
Expected: PASS (all Teams flush tests).

- [ ] **Step 5: Confirm broader notification/email tests still pass**

Run: `npx vitest run src/platform/notifications src/app/api/cron/email`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/platform/notifications/send.ts src/platform/notifications/send.flush.test.ts
git commit -m "feat(teams): deliver DMs on enqueue via post-response flush"
```

---

### Task 6: Documentation and cron header

Update the route header comment and the cron manifest to describe the new model. No code behavior change. The external cron-job.org interval change (from `* * * * *` to `*/30 * * * *`) is a manual dashboard step done by the maintainer; this task documents it.

**Files:**
- Modify: `src/app/api/cron/email/route.ts` (header comment only)
- Modify: `docs/cron-jobs.md`

- [ ] **Step 1: Rewrite the route header comment**

In `src/app/api/cron/email/route.ts`, replace the entire top block comment (lines 1-34, everything before `import { authorizeCron }`) with:

```ts
/**
 * Safety-net email/Teams tick. Primary delivery is now on ENQUEUE: queueEmail and
 * queueTeamsMessage schedule a post-response drain (see
 * src/platform/flush-on-enqueue.ts), so a queued message goes out in ~1s. This
 * route is the BACKSTOP that guarantees eventual delivery when no enqueue-driven
 * flush ran: it retries failed rows and dispatches any scheduled campaign.
 *
 * Triggered by an EXTERNAL scheduler (cron-job.org) hitting this path with
 * `Authorization: Bearer $CRON_SECRET`, now every 30 MINUTES (was every minute).
 * Vercel only runs vercel.json crons on a fully-active paid plan, so we drive it
 * externally to stay plan-independent; vercel.json declares no `crons`.
 *
 * Each tick:
 *   1. dispatchDueCampaigns  -- fire any SCHEDULED/RECURRING campaign whose
 *      nextRunAt has passed, enqueuing its recipient emails.
 *   2. drainEmailQueue / drainTeamsQueue -- deliver every eligible QUEUED row.
 *
 * Concurrency is safe: this backstop drain, enqueue-triggered flushes, and any
 * overlapping tick can all run at once because each drain claims a row with an
 * atomic updateMany on lockedAt before sending, so no row is sent twice. (The old
 * "exactly one drainer or it double-sends" rule is superseded by that claim.)
 *
 * Each drain attempts every eligible QUEUED row AT MOST ONCE per call. Do NOT
 * wrap it in a `while (processed > 0)` loop: a failed row stays QUEUED, and a
 * failed row is kept LOCKED for STALE_LOCK_MS, so its retry is paced by that
 * window (not by trigger frequency). Re-looping would burn all 8 retries during a
 * transient outage (issue #63).
 */
```

- [ ] **Step 2: Update the cron manifest**

In `docs/cron-jobs.md`, change the `/api/cron/email` table row from:

```
| `/api/cron/email` | External (cron-job.org) | every minute | `* * * * *` | Dispatches due campaigns, then drains the email + Teams notification queues. The **sole** drainer. | Queued email and Teams notifications never send. |
```

to:

```
| `/api/cron/email` | External (cron-job.org) | every 30 min | `*/30 * * * *` | Dispatches due campaigns, then drains the email + Teams queues. **Backstop** only: primary delivery fires on enqueue (post-response flush). | Failed-send retries and scheduled campaigns stall (new transactional mail still goes out on enqueue). |
```

Then replace the first two bullets under **Notes:** (the "Exactly one scheduler" bullet and the "reminders is deliberately split" bullet) with:

```
- Primary delivery is **on enqueue**: `queueEmail` / `queueTeamsMessage` schedule
  a post-response drain, so a queued message goes out in ~1s. This 30-min tick is
  the backstop that retries failed sends and dispatches scheduled campaigns.
- Multiple drainers now coexist safely (enqueue-triggered flushes, this tick, and
  any overlapping tick): each drain claims a row with an atomic `updateMany` on
  `lockedAt` before sending, so no row is sent twice. A failed row is kept locked
  for `STALE_LOCK_MS` (5 min), so retries are paced by that window regardless of
  how often a drain is triggered.
- The `reminders` and `shift-reminders` jobs still only **enqueue**; their mail is
  delivered by the enqueue flush after they run, or by this backstop tick.
```

- [ ] **Step 3: Verify no em-dash and lint/typecheck pass**

Run: `grep -n "—" src/app/api/cron/email/route.ts docs/cron-jobs.md` (expect no output)
Run: `npx eslint src/app/api/cron/email/route.ts src/platform/flush-on-enqueue.ts src/platform/email/send.ts src/platform/notifications/send.ts`
Run: `npx tsc --noEmit`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/email/route.ts docs/cron-jobs.md
git commit -m "docs(cron): document fire-on-enqueue delivery and 30-min backstop"
```

---

### Task 7: Full verification

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (all suites, including the pre-existing ones).

- [ ] **Step 2: Lint and typecheck the whole project**

Run: `npm run lint && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke (optional, requires the dev app + a real request scope)**

In `next dev`, trigger any transactional email (for example request a recruitment portal magic link) and confirm the `EmailLog` row flips to `SENT` within a second or two without invoking `/api/cron/email`. This exercises the real `after()` path that unit tests deliberately no-op.

- [ ] **Step 4: Post-merge operational step (maintainer, not code)**

In the cron-job.org dashboard, change the `/api/cron/email` job schedule from `* * * * *` to `*/30 * * * *`. Leave the other cron jobs unchanged.

---

## Notes for the implementer

- **Import-cycle check:** `flush-on-enqueue.ts` imports only `next/server`. `email/send.ts` and `notifications/send.ts` both import it; neither imports the other in the new direction (notifications already imports email for the fallback path, and that stays one-directional). If `tsc` reports a cycle, re-check that you did not add an import from `email/send.ts` back into `notifications/send.ts`.
- **Ordering in `send.ts` files:** the `const emailFlusher = ...` / `const teamsFlusher = ...` blocks reference `drainEmailQueue` / `drainTeamsQueue`, which are hoisted function declarations defined lower in the same file. This is fine because the flusher's drain callback is only invoked at call time, never during module evaluation.
- **Why tests see `QUEUED`, not `SENT`, after a bare `queueEmail`:** the route-handler and service tests call functions directly, with no Next request scope, so `after()` throws and `schedule()` no-ops. Delivery in tests is driven explicitly by `flushEmailQueue()` / `flushTeamsQueue()` or by the route's own drain.
```
