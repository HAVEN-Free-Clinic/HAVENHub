import { log, errorAttrs } from "@/platform/logging";

/**
 * Outage state for a long-lived polling loop (the SSE change streams), so a
 * database blip produces two log lines instead of one per tick.
 *
 * The streams poll every couple of seconds for up to ~5 minutes. Logging each
 * failed tick turned one unreachable Neon endpoint into 233 warnings in four
 * minutes on a single preview. This logs once on ENTERING the unreachable state
 * and once on RECOVERY, and stretches the poll interval while it lasts:
 * baseMs, then doubling per consecutive failure, capped at maxMs so the first
 * tick after the database returns is never more than maxMs away.
 *
 * Classification stays with the caller (isDbUnreachableError): this only tracks
 * what the caller told it. Per-stream instance, not module state, so one
 * viewer's outage bookkeeping cannot leak into another's stream.
 */
export function createUnreachableBackoff(opts: {
  /** Log prefix, e.g. "[check-in]". */
  scope: string;
  /** The healthy poll interval. */
  baseMs: number;
  /** Upper bound on the backed-off interval. */
  maxMs: number;
  /** Clock seam for tests. */
  now?: () => number;
}): {
  /** Record an unreachable tick. Logs only on the first of a run. */
  failed: (err: unknown) => void;
  /** Record a healthy tick. Logs only when it ends an outage. */
  succeeded: () => void;
  /** How long to wait before the next tick. */
  nextDelayMs: () => number;
} {
  const now = opts.now ?? Date.now;
  let failures = 0;
  let downSince = 0;

  return {
    failed(err) {
      failures += 1;
      if (failures === 1) {
        downSince = now();
        log.warn(
          `${opts.scope} database unreachable on a stream tick; backing off until it recovers`,
          errorAttrs(err),
        );
      }
    },
    succeeded() {
      if (failures === 0) return;
      log.info(`${opts.scope} database reachable again on a stream tick`, {
        failedTicks: failures,
        downMs: now() - downSince,
      });
      failures = 0;
    },
    nextDelayMs() {
      if (failures === 0) return opts.baseMs;
      // 2^failures grows without bound; clamp the exponent so it stays finite.
      return Math.min(opts.baseMs * 2 ** Math.min(failures, 16), opts.maxMs);
    },
  };
}
