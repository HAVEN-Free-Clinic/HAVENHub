/**
 * Safety-net email/Teams tick. Primary delivery is now on ENQUEUE: queueEmail and
 * queueTeamsMessage schedule a post-response drain (see
 * src/platform/flush-on-enqueue.ts), so a queued message goes out in ~1s. This
 * route is the BACKSTOP that guarantees eventual delivery when no enqueue-driven
 * flush ran: it retries failed rows and dispatches any scheduled campaign.
 *
 * Triggered by an EXTERNAL scheduler (cron-job.org) hitting this path with
 * `Authorization: Bearer $CRON_SECRET`, now every 30 MINUTES (was every minute).
 * Vercel only runs vercel.json crons on a fully-active paid plan, so we drive it
 * externally to stay plan-independent; vercel.json declares no `crons`.
 *
 * Each tick:
 *   1. dispatchDueCampaigns  -- fire any SCHEDULED/RECURRING campaign whose
 *      nextRunAt has passed, enqueuing its recipient emails.
 *   2. drainEmailQueue / drainTeamsQueue -- deliver every eligible QUEUED row.
 *
 * Concurrency is safe: this backstop drain, enqueue-triggered flushes, and any
 * overlapping tick can all run at once because each drain claims a row with an
 * atomic updateMany on lockedAt before sending, so no row is sent twice. (The old
 * "exactly one drainer or it double-sends" rule is superseded by that claim.)
 *
 * Each drain attempts every eligible QUEUED row AT MOST ONCE per call. Do NOT
 * wrap it in a `while (processed > 0)` loop: a transiently-failed row stays
 * QUEUED and keeps its lock for STALE_LOCK_MS, so its retry is paced by that
 * window (not by trigger frequency); a permanently-failed row (FAILED after 8
 * attempts) instead releases its lock so an admin retry is immediately
 * claimable. Re-looping would burn all 8 retries during a transient outage
 * (issue #63).
 */
import { authorizeCron } from "@/platform/cron";
import { dispatchDueCampaigns } from "@/platform/email/campaigns/dispatch";
import { drainEmailQueue } from "@/platform/email/send";
import { resolveEmailTransport } from "@/platform/email/transport";
import { log, flushLogs } from "@/platform/logging";
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

  log.info("[cron/email] backstop tick complete", {
    result: JSON.stringify({ dispatched: executed, errors, emails, teams }),
  });
  // Flush before returning so the tick's logs reach PostHog. The
  // SimpleLogRecordProcessor exports each record eagerly, so this only awaits
  // the in-flight send; unlike `after()` it needs no request scope, so the
  // route stays callable directly (e.g. from unit tests).
  await flushLogs();

  return Response.json({ ok: true, dispatched: executed, errors, emails, teams });
}
