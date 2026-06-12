/**
 * Per-minute email tick (Pro-plan cron, see vercel.json).
 *
 * This is the SOLE drainer of the outbound email queue, restoring the
 * background worker's per-minute EMAIL_QUEUE + CAMPAIGN_DISPATCH cadence on
 * Vercel's serverless model:
 *
 *   1. dispatchDueCampaigns -- fire any SCHEDULED/RECURRING campaign whose
 *      nextRunAt has passed, enqueuing its recipient emails.
 *   2. drainEmailQueue (loop until empty) -- deliver every QUEUED row, whether
 *      it came from a campaign just dispatched above, a "send now" action, or a
 *      transactional trigger (recruitment, epic, reminders) enqueued since the
 *      last tick.
 *
 * Because this runs every minute, an email queued "right now" goes out within
 * ~60s, and a scheduled campaign fires within ~60s of its time. To avoid the
 * double-send that two concurrent drains would cause (drainEmailQueue assumes a
 * single drainer -- no SELECT FOR UPDATE SKIP LOCKED), the daily nightly and
 * reminders crons no longer drain email; this route owns delivery.
 */
import { authorizeCron } from "@/platform/cron";
import { dispatchDueCampaigns } from "@/platform/email/campaigns/dispatch";
import { drainEmailQueue } from "@/platform/email/send";
import { resolveEmailTransport } from "@/platform/email/transport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const { executed, errors } = await dispatchDueCampaigns(new Date());

  const transport = await resolveEmailTransport();
  let emails = 0;
  let processed: number;
  do {
    processed = await drainEmailQueue(transport);
    emails += processed;
  } while (processed > 0);

  return Response.json({ ok: true, dispatched: executed, errors, emails });
}
