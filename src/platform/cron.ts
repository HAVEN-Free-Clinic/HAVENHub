/**
 * Shared helpers for the Vercel Cron routes under src/app/api/cron/*.
 *
 * Originally these jobs ran on an in-process pg-boss schedule. The serverless
 * deployment has no long-running process, so each job is exposed as an HTTP
 * route triggered by Vercel Cron (see vercel.json). The underlying job
 * functions are all DB-backed and callable directly -- pg-boss was only ever
 * the trigger, never the work.
 */

/**
 * Authorize a cron invocation. Vercel attaches `Authorization: Bearer
 * $CRON_SECRET` to cron requests when CRON_SECRET is set on the project. We
 * fail closed: no secret configured -> every request is rejected.
 */
export function authorizeCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
