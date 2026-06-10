/**
 * Daily maintenance (Hobby-plan friendly: one daily run).
 *
 * Order: recompute compliance statuses (enqueues mirror changes) -> drain the
 * mirror outbox -> reconcile People against Airtable -> drain the email queue.
 * This folds the worker's per-minute OUTBOX/EMAIL drains and the nightly
 * compliance refresh + reconcile into a single daily job, because Hobby plans
 * only allow daily cron frequency. On Pro, split these back out and raise the
 * cadence (see git history / the standalone /api/cron/drain route).
 */
import { authorizeCron, airtableClient, mirrorTarget } from "@/platform/cron";
import { refreshComplianceMirror } from "@/platform/compliance/mirror-status";
import { reconcilePeople } from "@/platform/airtable/reconcile";
import { drainOutbox } from "@/platform/airtable/mirror";
import { drainEmailQueue } from "@/platform/email/send";
import { resolveEmailTransport } from "@/platform/email/transport";

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
      processed = await drainOutbox(client, mirrorTarget());
      outbox += processed;
    } while (processed > 0);
    corrected = await reconcilePeople(client, mirrorTarget());
  }

  const transport = await resolveEmailTransport();
  let emails = 0;
  let processed: number;
  do {
    processed = await drainEmailQueue(transport);
    emails += processed;
  } while (processed > 0);

  return Response.json({ ok: true, enqueued, outbox, corrected, emails });
}
