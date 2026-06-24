/**
 * Per-minute email tick. Triggered by an EXTERNAL scheduler (cron-job.org)
 * hitting this path every minute with `Authorization: Bearer $CRON_SECRET`, not
 * by Vercel Cron -- Vercel only executes crons on a fully-active paid plan, so
 * we drive it externally to stay plan-independent. There must be exactly ONE
 * scheduler pointed here (see note below); `crons` is intentionally absent from
 * vercel.json so Vercel does not also fire it.
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
 * reminders crons no longer drain email, and only one external scheduler may
 * call this route; this route owns delivery.
 */
import { authorizeCron } from "@/platform/cron";
import { dispatchDueCampaigns } from "@/platform/email/campaigns/dispatch";
import { drainEmailQueue } from "@/platform/email/send";
import { resolveEmailTransport } from "@/platform/email/transport";
import { drainTeamsQueue } from "@/platform/notifications/send";
import { resolveTeamsTransport } from "@/platform/notifications/teams-transport";

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

  const teamsTransport = await resolveTeamsTransport();
  let teams = 0;
  let teamsProcessed: number;
  do {
    teamsProcessed = await drainTeamsQueue(teamsTransport);
    teams += teamsProcessed;
  } while (teamsProcessed > 0);

  return Response.json({ ok: true, dispatched: executed, errors, emails, teams });
}
