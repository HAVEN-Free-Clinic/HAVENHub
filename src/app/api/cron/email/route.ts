/**
 * Per-minute email tick. Triggered by an EXTERNAL scheduler (cron-job.org)
 * hitting this path every minute with `Authorization: Bearer $CRON_SECRET`, not
 * by Vercel Cron -- Vercel only executes crons on a fully-active paid plan, so
 * we drive it externally to stay plan-independent. There must be exactly ONE
 * scheduler pointed here (see note below). vercel.json may carry non-draining
 * Vercel crons (today: recruitment-drafts), but this email route -- the SOLE
 * queue drainer -- must never be added to vercel.json `crons`, or Vercel would
 * fire it in parallel with the external scheduler and double-drain.
 *
 * This is the SOLE drainer of the outbound email queue, restoring the
 * background worker's per-minute EMAIL_QUEUE + CAMPAIGN_DISPATCH cadence on
 * Vercel's serverless model:
 *
 *   1. dispatchDueCampaigns -- fire any SCHEDULED/RECURRING campaign whose
 *      nextRunAt has passed, enqueuing its recipient emails.
 *   2. drainEmailQueue -- deliver every QUEUED row, whether it came from a
 *      campaign just dispatched above, a "send now" action, or a transactional
 *      trigger (recruitment, epic, reminders) enqueued since the last tick.
 *
 * drainEmailQueue / drainTeamsQueue each fully walk their backlog in a single
 * call, attempting every QUEUED row AT MOST ONCE per tick. Do NOT wrap them in a
 * `while (processed > 0)` loop: a failed row stays QUEUED, so re-invoking within
 * the same tick would re-attempt it pass after pass and burn all 8 retries in
 * seconds during a transient outage (issue #63). Retries are intentionally
 * spread one-per-minute across ticks.
 *
 * Because this runs every minute, an email queued "right now" goes out within
 * ~60s, and a scheduled campaign fires within ~60s of its time. To avoid the
 * double-send that two concurrent drains would cause (drainEmailQueue assumes a
 * single drainer -- no SELECT FOR UPDATE SKIP LOCKED), the daily reminders cron
 * no longer drains email, and only one external scheduler may
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

  // One drain per tick -- each fully empties the eligible backlog and attempts
  // every QUEUED row at most once. See the header note: do not re-loop.
  const transport = await resolveEmailTransport();
  const emails = await drainEmailQueue(transport);

  const teamsTransport = await resolveTeamsTransport();
  const teams = await drainTeamsQueue(teamsTransport);

  return Response.json({ ok: true, dispatched: executed, errors, emails, teams });
}
