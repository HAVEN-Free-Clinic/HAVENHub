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
 * All TEN jobs are triggered by one external scheduler (cron-job.org), where each
 * can also be individually switched off. Vercel only fires vercel.json crons on a
 * sufficiently-provisioned paid plan (see commit 7be5efd), so nothing is
 * scheduled there -- vercel.json declares no `crons`.
 *
 * `docs/cron-jobs.md` is the manifest: paths, cadences, what each job does, and
 * how to re-provision. Do not re-list the jobs here; this comment named three of
 * them and the wrong cadence for email until audit 14, which is exactly the kind
 * of drift a second copy invites.
 *
 * The cron-job.org dashboard is the authority on what is actually scheduled and
 * enabled -- not this file, not the docs, and not the logs (see the note about
 * lossy completion logs in docs/cron-jobs.md).
 */

import { constantTimeBearerMatch } from "./security";
import { log } from "./logging";

/**
 * Authorize a cron invocation. The external scheduler (cron-job.org) is
 * configured to send `Authorization: Bearer $CRON_SECRET` on every job. We fail
 * closed: no secret configured -> every request is rejected. The token is
 * compared in constant time (see constantTimeBearerMatch) so a forged header
 * cannot recover the secret byte-by-byte through response-timing differences.
 *
 * A rejection is LOGGED, at warn. It used to be silent, which made the two
 * states an operator has to tell apart produce identical evidence -- nothing at
 * all (audit 14):
 *
 *   - the schedule was never provisioned, or is switched off, and
 *   - the schedule fires every night and 401s because CRON_SECRET was rotated
 *     on Vercel without updating the cron-job.org header.
 *
 * The second is an outage; the first may be deliberate. `reason` distinguishes a
 * missing deployment secret from a bad header, and `path` names the job. No part
 * of the credential is logged.
 */
export function authorizeCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log.warn("[cron] rejected: no CRON_SECRET configured on this deployment", {
      path: safePath(req),
    });
    return false;
  }
  if (!constantTimeBearerMatch(req.headers.get("authorization"), secret)) {
    log.warn("[cron] rejected: missing or wrong Authorization header", {
      path: safePath(req),
      hadHeader: req.headers.get("authorization") !== null,
    });
    return false;
  }
  return true;
}

/** Path only, never the query string, which could carry anything. */
function safePath(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return "(unparseable)";
  }
}
