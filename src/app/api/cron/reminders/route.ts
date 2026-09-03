/**
 * Daily clearance reminders: the HIPAA certificate stream and the onboarding
 * requirements stream. Per-person, per-leg dedup lives inside
 * runClearanceReminders, so a daily trigger is safe for both even though their
 * intervals differ.
 *
 * Triggered DAILY at 13:00 UTC (9:00 AM ET in summer) by an EXTERNAL scheduler
 * (cron-job.org) hitting this path with `Authorization: Bearer $CRON_SECRET`, not by
 * Vercel Cron; this route is intentionally absent from vercel.json (see
 * docs/cron-jobs.md). If that external schedule is lost on re-provision, every
 * clearance reminder is silently never sent.
 *
 * This route only ENQUEUES. Delivery is handled by the post-enqueue flush and
 * backstopped by /api/cron/email. Draining here would run concurrently with that
 * route and double-send.
 */
import { authorizeCron } from "@/platform/cron";
import { recordCronHeartbeat } from "@/platform/cron-heartbeat";
import { log, flushLogs } from "@/platform/logging";
import { runClearanceReminders } from "@/platform/email/reminders";
import { runAttendanceNudges } from "@/platform/email/attendance-nudges";
import { relinkUnlinkedAttendance } from "@/modules/recruitment/services/attendance-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const r = await runClearanceReminders();

  // Event check-in follow-ups ride this same daily trigger: their own interval
  // and per-row claim live in runAttendanceNudges, exactly like the two legs
  // above, so a daily call is safe. Linking runs first so a walk-up who has
  // since onboarded is nudged as the member they now are -- with their real
  // outstanding list -- rather than as an anonymous email address.
  //
  // Separately guarded: this stream is newer and narrower than clearance
  // reminders, and a failure in it must not cost the compliance-critical run
  // above its heartbeat.
  let attendance = { linked: 0, sent: 0, resolved: 0, skipped: 0, failed: 0 };
  try {
    const linked = await relinkUnlinkedAttendance();
    attendance = { linked, ...(await runAttendanceNudges()) };
  } catch (error) {
    log.error("[cron/reminders] attendance nudges failed", { error: String(error) });
  }

  // Flattened with a prefix rather than nested: log attributes are scalars.
  log.info("[cron/reminders] complete", {
    ...r,
    attendanceLinked: attendance.linked,
    attendanceNudgesSent: attendance.sent,
    attendanceResolved: attendance.resolved,
    attendanceSkipped: attendance.skipped,
    attendanceFailed: attendance.failed,
  });
  await recordCronHeartbeat("reminders");
  await flushLogs();
  return Response.json({ ok: true, ...r, attendance });
}
