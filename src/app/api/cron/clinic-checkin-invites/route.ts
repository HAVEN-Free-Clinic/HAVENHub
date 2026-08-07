/**
 * Morning-of clinic check-in invitations.
 *
 * Triggered DAILY at 11:00 UTC (7:00 AM ET in summer) by an EXTERNAL scheduler
 * (cron-job.org) hitting this path with `Authorization: Bearer $CRON_SECRET`,
 * not by Vercel Cron; this route is intentionally absent from vercel.json (see
 * docs/cron-jobs.md). Daily rather than weekly so a rescheduled or midweek
 * clinic still gets its email; the runner no-ops on non-clinic days.
 *
 * This route only ENQUEUES; delivery is handled by the per-minute
 * /api/cron/email drainer within ~60s. Draining here would run concurrently
 * with that route and double-send.
 */
import { authorizeCron } from "@/platform/cron";
import { recordCronHeartbeat } from "@/platform/cron-heartbeat";
import { log, flushLogs } from "@/platform/logging";
import { runCheckInInvites } from "@/platform/email/checkin-invites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const r = await runCheckInInvites();

  log.info("[cron/clinic-checkin-invites] complete", { ...r });
  await recordCronHeartbeat("clinic-checkin-invites");
  await flushLogs();
  return Response.json({ ok: true, ...r });
}
