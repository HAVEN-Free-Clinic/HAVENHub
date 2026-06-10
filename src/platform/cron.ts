/**
 * Shared helpers for the Vercel Cron routes under src/app/api/cron/*.
 *
 * On SpinUp the background worker (worker/index.ts) ran these jobs on an
 * in-process pg-boss schedule. Vercel has no long-running process, so each job
 * is exposed as an HTTP route triggered by Vercel Cron (see vercel.json). The
 * underlying job functions are all DB-backed and callable directly -- pg-boss
 * was only ever the trigger, never the work.
 */
import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
export { mirrorTarget } from "@/platform/airtable/mirror-target";

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

/** The Airtable client, or null when no PAT is configured (mirror disabled). */
export function airtableClient(): AirtableClient | null {
  return config.AIRTABLE_PAT ? new AirtableClient(config.AIRTABLE_PAT) : null;
}
