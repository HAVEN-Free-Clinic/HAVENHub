/**
 * Daily maintenance: recompute compliance statuses (enqueues mirror changes) ->
 * drain the mirror outbox -> reconcile People against Airtable.
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
