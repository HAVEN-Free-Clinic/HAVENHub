/**
 * Shared helpers for the cron routes under src/app/api/cron/*.
 *
 * Originally these jobs ran on an in-process pg-boss schedule. The serverless
 * deployment has no long-running process, so each job is exposed as an HTTP
 * route triggered on a schedule. The underlying job functions are all DB-backed
 * and callable directly -- pg-boss was only ever the trigger, never the work.
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

/**
 * Authorize a cron invocation. Both triggers send `Authorization: Bearer
 * $CRON_SECRET`: Vercel attaches it to vercel.json crons when CRON_SECRET is set
 * on the project, and the external scheduler (cron-job.org) is configured to
 * send the same header. We fail closed: no secret configured -> every request is
 * rejected.
 */
export function authorizeCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
