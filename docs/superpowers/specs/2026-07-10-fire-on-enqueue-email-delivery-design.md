# Fire-on-enqueue email & Teams delivery

**Date:** 2026-07-10
**Status:** Design approved, pending spec review

## Problem

Outbound email and Teams DMs are delivered by a single external scheduler
(cron-job.org) that hits `/api/cron/email` **every minute**. That tick dispatches
due campaigns and drains the email + Teams queues. Almost every tick finds an
empty queue, so the app pays (Neon compute, Vercel function invocations, and the
external scheduler dependency) to poll 1,440 times a day for work that is usually
not there, while a genuinely-queued message still waits up to ~60s to go out.

We want three things:

1. **Cut wasted cost:** stop polling an empty queue every minute.
2. **Lower latency:** a queued message should go out in ~1s, not up to 60s.
3. **Simplify ops:** fewer moving parts.

Recurring campaigns are effectively unused, so the periodic tick can slow to a
pure safety net.

## Approach

Deliver **on enqueue** instead of on a poll, keeping a much slower cron as a
backstop.

- When an email or Teams message is queued, schedule a drain to run **after the
  HTTP response finishes** (Next 16 `after()` from `next/server`). Because
  `after()` fires post-response, it always runs *after* the caller's
  `$transaction` has committed, so the freshly-queued row is visible to the
  drain. Delivery latency drops to ~1s.
- **Slow the safety-net cron from every minute to every 30 minutes.** It still
  runs `dispatchDueCampaigns` + both drains, now serving only as a backstop for
  retries and any scheduled campaign. This is an external cron-job.org dashboard
  change (interval `* * * * *` → `*/30 * * * *`); the route code is unchanged.

This is a **hybrid**, not a pure removal of the cron, because two things are
inherently time-based, not enqueue-based, and cannot be triggered by an enqueue:

- **Scheduled/recurring campaigns:** a campaign set for a future time has
  nothing enqueued until dispatch time, so *something* periodic must notice it is
  due. (Rarely used, so 30-min granularity is fine.)
- **Retries:** a failed send stays `QUEUED`; the cron is the guaranteed periodic
  retry driver even if no new message is ever enqueued again.

### Why the chokepoint, not the call sites

`queueEmail` (`src/platform/email/send.ts`) and `queueTeamsMessage`
(`src/platform/notifications/send.ts`) are the two enqueue chokepoints, called
from ~13 sites, most inside a domain `$transaction`. Hooking the trigger into
these two functions covers every current and future call site with no call-site
churn, and `after()`'s post-response timing removes the "row not committed yet"
race for free.

## Components

### 1. Shared coalescing flusher: `src/platform/flush-on-enqueue.ts` (new, leaf)

A tiny factory that wraps any drain function. Imports only `after` from
`next/server`, so it introduces no import cycle (email and notification modules
both depend on it; it depends on neither).

```ts
import { after } from "next/server";

/**
 * Wrap a drain function so it fires once per request, after the response
 * commits. Returns:
 *  - flushNow(): run the drain, coalescing overlapping calls. A burst of
 *    enqueues in one request collapses to a single drain pass; if new work is
 *    enqueued *during* a drain, one more pass runs.
 *  - schedule(): register flushNow() to run after the response (post-commit, so
 *    it sees this request's just-written rows). No-ops outside a request scope
 *    (seed scripts, unit tests). The safety-net cron drains those.
 */
export function createEnqueueFlusher(drain: () => Promise<void>) {
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
      // No request scope (script / unit test): the 30-min cron will drain.
    }
  }

  return { flushNow, schedule };
}
```

**Coalescing correctness.** The `while (dirty)` loop is **not** the forbidden
`while (processed > 0)` loop of issue #63. It re-runs only when a *genuinely new*
row was enqueued mid-drain (`dirty` set by another `flushNow` call), never to
re-hammer a failed row (a failed row does not set `dirty`, and the retry gate in
§3 keeps it locked). The `dirty`/`draining` flags are module-instance state:
concurrent requests on the same serverless instance coalesce onto one drain;
requests on different instances drain independently, which is safe because
`drainEmailQueue` / `drainTeamsQueue` already claim each row atomically
(`updateMany` on `lockedAt`) so no row is sent twice. A lost-wakeup race is
avoided because the loop's exit path (`while (dirty)` false → `finally`) has no
`await`, so it cannot interleave with another callback's `dirty = true`.

### 2. Wiring the two chokepoints

**Email** (`src/platform/email/send.ts`): create an email flusher at module load
and call `schedule()` at the end of `queueEmail`.

```ts
import { createEnqueueFlusher } from "@/platform/flush-on-enqueue";
import { resolveEmailTransport } from "./transport";

const emailFlusher = createEnqueueFlusher(async () => {
  const transport = await resolveEmailTransport();
  await drainEmailQueue(transport);
});

/** Exposed for tests (and available if the cron route ever wants coalescing;
 *  the route keeps calling drainEmailQueue directly for now). */
export const flushEmailQueue = emailFlusher.flushNow;

export async function queueEmail(db: Db, input: QueueEmailInput): Promise<EmailLog> {
  const sender = await resolveSenderForTemplate(input.template);
  const row = await db.emailLog.create({ /* ...unchanged... */ });
  emailFlusher.schedule(); // deliver ~1s after the response commits
  return row;
}
```

**Teams** (`src/platform/notifications/send.ts`): symmetric.

```ts
import { createEnqueueFlusher } from "@/platform/flush-on-enqueue";
import { resolveTeamsTransport } from "./teams-transport";

const teamsFlusher = createEnqueueFlusher(async () => {
  const transport = await resolveTeamsTransport();
  await drainTeamsQueue(transport);
});
export const flushTeamsQueue = teamsFlusher.flushNow;

export async function queueTeamsMessage(db: Db, input: QueueTeamsInput): Promise<TeamsMessage> {
  const row = await db.teamsMessage.create({ /* ...unchanged... */ });
  teamsFlusher.schedule();
  return row;
}
```

No import cycle: `flush-on-enqueue.ts` is a leaf; `notifications/send.ts` already
imports `email/send.ts` (for the failure email fallback), and `email/send.ts`
does not import notifications.

### 3. Retry gate: keep the lock on failure

Today a failed send resets `lockedAt: null`, making the row instantly
re-claimable; retries are paced *only* by the cron firing once a minute. Once an
**enqueue** can trigger a drain, that pacing is gone: an enqueue burst during a
transport outage could re-attempt the same failed row on every burst and burn all
8 attempts in seconds, a re-run of issue #63's failure mode.

Fix: on a transient failure, **keep `lockedAt` set to the claim time** instead of
nulling it. The row is then not re-claimable until the existing
`STALE_LOCK_MS` (5 min) window elapses, regardless of how many flushes fire,
which decouples retry cadence from trigger frequency. Migration-free; one line in
each drain's transient-failure branch.

- `src/platform/email/send.ts`, `drainEmailQueue` catch: `lockedAt: null` →
  `lockedAt: claimedAt`.
- `src/platform/notifications/send.ts`, `drainTeamsQueue` transient branch
  (`attempts < TEAMS_MAX_ATTEMPTS`, line ~179): `lockedAt: null` →
  `lockedAt: claimedAt`.

The permanent-failure branches set `status` to `FAILED`/`FALLBACK` (no longer
`QUEUED`), so their `lockedAt` value is irrelevant and stays as-is. Success paths
still release the lock (`lockedAt: null`).

Effect on retry timing: a failed transient send now retries at earliest ~5 min
(if another enqueue happens) and at latest ~30 min (the safety-net cron), bounded
across all 8 attempts. The 5-min gate doubles as crash recovery, as before.

### 4. Safety-net cron

`/api/cron/email/route.ts` is functionally unchanged; it remains the periodic
`dispatchDueCampaigns` + email drain + Teams drain, now a backstop. Only its
header comment changes to describe the new model (enqueue-triggered primary
delivery; 30-min backstop; concurrent drains are safe via atomic per-row claims,
so the old "exactly one drainer or it double-sends" framing is superseded by the
claim; multiple drainers now legitimately coexist).

External change (done in the cron-job.org dashboard, not in the repo): the
`/api/cron/email` schedule goes from `* * * * *` to `*/30 * * * *`.

## Error handling & edge cases

- **Rolled-back transaction.** `schedule()` may run even if the enqueuing
  transaction rolls back (the queued row never commits). The post-response drain
  then simply finds no such row and drains nothing, which is harmless, and atomicity is
  preserved (a rolled-back send never happens).
- **`after()` outside a request scope.** Seed scripts and unit tests call
  `queueEmail`/`queueTeamsMessage` with no request context; `after()` throws
  there and is swallowed by the `try/catch`, so enqueue still succeeds and the
  cron drains later. Verify that importing `next/server` in a plain Node script
  context is harmless (fall back to a dynamic import inside `schedule()` only if
  it is not).
- **Teams permanent-failure email fallback.** `drainTeamsQueue` queues a fallback
  email via `queueEmail`, which calls `emailFlusher.schedule()`. If the Teams
  drain is itself running inside an `after()` callback, the nested `after()` is
  out of scope and is swallowed; the fallback email goes out on the next email
  flush or the cron. Safe.
- **Cost of `after()` work.** Post-response drains are billed as function CPU,
  but they replace 1,440 daily cron invocations with ~1 drain per message sent
  plus 48 backstop ticks, a large net reduction at this app's volume.

## Testing

- **Coalescing:** many `schedule()`/`flushNow` calls in one request collapse to a
  bounded number of `drain` invocations; a row enqueued *during* a drain triggers
  exactly one follow-up pass.
- **Retry gate (email & Teams):** a row whose send fails is **not** re-attempted
  by repeated `flushNow` calls within `STALE_LOCK_MS`, and **is** re-attempted
  after the window; attempts increment once per gated retry, never in a burst.
- **Request-scope guard:** `queueEmail` / `queueTeamsMessage` succeed and do not
  throw when `after()` is unavailable (plain unit-test context).
- **Regression:** the existing `route.outage.test.ts` retry-spreading behavior
  still holds under the `lockedAt`-on-failure change (retries remain spread, now
  gated by the lock instead of by tick frequency).
- **Verification:** in dev, enqueue a transactional email (e.g. a recruitment
  portal link) and confirm it sends within ~1s without waiting for a cron tick.

## Files touched

| File | Change |
| --- | --- |
| `src/platform/flush-on-enqueue.ts` | **New.** `createEnqueueFlusher`. |
| `src/platform/email/send.ts` | Email flusher + `flushEmailQueue`; `schedule()` in `queueEmail`; `lockedAt` retry gate + comment in `drainEmailQueue`. |
| `src/platform/notifications/send.ts` | Teams flusher + `flushTeamsQueue`; `schedule()` in `queueTeamsMessage`; `lockedAt` retry gate + comment in `drainTeamsQueue`. |
| `src/app/api/cron/email/route.ts` | Header comment: new delivery model, 30-min backstop. |
| `docs/cron-jobs.md` | Update the `/api/cron/email` row (cadence, "primary delivery is on enqueue", concurrent-drain safety note). |
| Tests | Coalescing, retry gate, request-scope guard; re-verify outage test. |

## Out of scope

- Migrating off cron-job.org to Vercel Cron (kept external; only the interval
  changes).
- Reworking `dispatchDueCampaigns` (recurring campaigns remain rare; the 30-min
  backstop covers them).
- Exponential backoff via a new `nextAttemptAt` column (the reused 5-min lock
  window is sufficient; revisit only if finer retry control is needed).
