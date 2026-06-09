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
import { parseFieldMap } from "@/platform/airtable/mirror-map";
import type { MirrorTarget } from "@/platform/airtable/mirror";

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

/** Build the Airtable mirror target from config (mirrors worker/index.ts). */
export function mirrorTarget(): MirrorTarget {
  return {
    enabled: config.AIRTABLE_MIRROR_ENABLED,
    baseId: config.AIRTABLE_MIRROR_BASE_ID ?? "",
    peopleTableId: config.AIRTABLE_MIRROR_PEOPLE_TABLE_ID ?? "",
    fieldMap: parseFieldMap(config.AIRTABLE_MIRROR_FIELD_MAP),
    hipaaFieldId: config.AIRTABLE_MIRROR_HIPAA_FIELD_ID ?? null,
    statusFieldId: config.AIRTABLE_MIRROR_STATUS_FIELD_ID ?? null,
  };
}

/** The Airtable client, or null when no PAT is configured (mirror disabled). */
export function airtableClient(): AirtableClient | null {
  return config.AIRTABLE_PAT ? new AirtableClient(config.AIRTABLE_PAT) : null;
}
