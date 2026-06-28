/**
 * Daily maintenance: recompute compliance statuses (enqueues mirror changes) ->
 * drain the mirror outbox -> reconcile People against Airtable.
 *
 * Triggered DAILY at 06:00 UTC by an EXTERNAL scheduler (cron-job.org) hitting
 * this path with `Authorization: Bearer $CRON_SECRET`, not by Vercel Cron; this
 * route is intentionally absent from vercel.json (see the /api/cron/email note
 * and docs/cron-jobs.md). If that external schedule is lost on re-provision,
 * compliance statuses and the Airtable mirror silently stop updating.
 *
 * Email delivery is NOT done here. The per-minute /api/cron/email route is the
 * sole drainer of the outbound email queue; draining here too would run
 * concurrently with that route at 06:00 UTC and double-send (drainEmailQueue
 * assumes a single drainer). Any compliance changes that enqueue email elsewhere
 * are delivered by the per-minute tick within ~60s.
 */
import { authorizeCron, airtableClient, mirrorTarget } from "@/platform/cron";
import { refreshComplianceMirror } from "@/platform/compliance/mirror-status";
import { reconcilePeople } from "@/platform/airtable/reconcile";
import { drainOutbox } from "@/platform/airtable/mirror";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const enqueued = await refreshComplianceMirror();

  const client = airtableClient();
  let outbox = 0;
  let corrected = 0;
  if (client) {
    let processed: number;
    do {
      processed = await drainOutbox(client, await mirrorTarget());
      outbox += processed;
    } while (processed > 0);
    corrected = await reconcilePeople(client, await mirrorTarget());
  }

  return Response.json({ ok: true, enqueued, outbox, corrected });
}
