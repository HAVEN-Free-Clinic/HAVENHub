/**
 * Weekly attending reminders. Sent Monday mornings to the attendings covering
 * the upcoming clinic day.
 *
 * Triggered WEEKLY on Mondays at 12:00 UTC (8:00 AM ET in summer) by an EXTERNAL
 * scheduler (cron-job.org) hitting this path with
 * `Authorization: Bearer $CRON_SECRET`, not by Vercel Cron; this route is
 * intentionally absent from vercel.json (see docs/cron-jobs.md).
 *
 * Separate from /api/cron/shift-reminders on purpose: that one reminds
 * VOLUNTEERS about their own shift and is owned by the schedule; this one is
 * Faculty Relations' letter to the attendings, with its own wording, its own
 * template, and its own send time.
 *
 * This route only ENQUEUES; delivery is handled by the per-minute
 * /api/cron/email drainer within ~60s. Draining here would run concurrently with
 * that route and double-send.
 */
import { authorizeCron } from "@/platform/cron";
import { recordCronHeartbeat } from "@/platform/cron-heartbeat";
import { log, flushLogs } from "@/platform/logging";
import { runAttendingReminders } from "@/platform/email/attending-reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const r = await runAttendingReminders();

  log.info("[cron/attending-reminders] complete", { ...r });
  await recordCronHeartbeat("attending-reminders");
  await flushLogs();
  return Response.json({ ok: true, ...r });
}
