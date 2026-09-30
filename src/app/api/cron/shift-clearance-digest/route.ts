/**
 * Weekly "on shift but not cleared" digest to department directors. Each
 * director gets one email listing everyone scheduled in their department(s) for
 * this week's clinic day who is not fully cleared, and what each is missing.
 *
 * Triggered WEEKLY on Wednesdays at 17:00 America/New_York by an EXTERNAL
 * scheduler (cron-job.org) hitting this path with
 * `Authorization: Bearer $CRON_SECRET`, not by Vercel Cron (see
 * docs/cron-jobs.md). Set the job's timezone to US Eastern rather than entering
 * a UTC hour, so it stays at 5pm across the DST change. This route only
 * ENQUEUES; delivery is handled by the enqueue flush and the /api/cron/email
 * backstop.
 */
import { authorizeCron } from "@/platform/cron";
import { recordCronHeartbeat } from "@/platform/cron-heartbeat";
import { log, flushLogs } from "@/platform/logging";
import { runShiftClearanceDigests } from "@/platform/email/shift-clearance-digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const r = await runShiftClearanceDigests();

  log.info("[cron/shift-clearance-digest] complete", { ...r });
  await recordCronHeartbeat("shift-clearance-digest");
  await flushLogs();
  return Response.json({ ok: true, ...r });
}
