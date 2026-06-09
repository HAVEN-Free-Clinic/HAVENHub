/**
 * Frequent drain: outbound email queue + Airtable mirror outbox.
 * Replaces the worker's per-minute EMAIL_QUEUE and OUTBOX_QUEUE schedules.
 */
import { authorizeCron, airtableClient, mirrorTarget } from "@/platform/cron";
import { config } from "@/platform/config";
import { drainEmailQueue } from "@/platform/email/send";
import { emailTransportFromConfig } from "@/platform/email/transport";
import { drainOutbox } from "@/platform/airtable/mirror";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const transport = emailTransportFromConfig(config);
  let emails = 0;
  let processed: number;
  do {
    processed = await drainEmailQueue(transport);
    emails += processed;
  } while (processed > 0);

  let outbox = 0;
  const client = airtableClient();
  if (client) {
    do {
      processed = await drainOutbox(client, mirrorTarget());
      outbox += processed;
    } while (processed > 0);
  }

  return Response.json({ ok: true, emails, outbox });
}
