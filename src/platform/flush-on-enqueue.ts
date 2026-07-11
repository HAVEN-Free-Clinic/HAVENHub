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
