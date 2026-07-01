/**
 * Shared helpers for the cron routes under src/app/api/cron/*.
 *
 * Originally these jobs ran on an in-process pg-boss worker. The serverless
 * deployment has no long-running process, so the worker has been retired and
 * each job is now an HTTP route triggered on a schedule. The job functions are
 * all DB-backed and callable directly -- the queue was only ever the trigger,
 * never the work. These routes are the single drain implementation; there is no
 * background worker to keep in sync.
 *
 * Two triggers are in play, and most jobs use the external one (Vercel only
 * fires vercel.json crons on a sufficiently-provisioned paid plan, see commit
 * 7be5efd):
 *   - external scheduler (cron-job.org): email (per-minute), reminders (daily).
 *     These are intentionally NOT in vercel.json.
 *   - Vercel Cron (vercel.json): recruitment-drafts (daily) only.
 * docs/cron-jobs.md is the manifest -- paths, cadences, what each job does, and
 * how to re-provision the external schedules.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Authorize a cron invocation. Both triggers send `Authorization: Bearer
 * $CRON_SECRET`: Vercel attaches it to vercel.json crons when CRON_SECRET is set
 * on the project, and the external scheduler (cron-job.org) is configured to
 * send the same header. We fail closed: no secret configured -> every request is
 * rejected. The token is compared in constant time so a forged header cannot
 * recover the secret byte-by-byte through response-timing differences.
 */
export function authorizeCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const provided = req.headers.get("authorization");
  if (!provided) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(provided);
  // timingSafeEqual requires equal-length buffers, so guard length first. The
  // expected length is fixed, so this comparison leaks no useful signal.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
