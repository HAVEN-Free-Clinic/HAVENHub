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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const r = await runClearanceReminders();

  log.info("[cron/reminders] complete", { ...r });
  await recordCronHeartbeat("reminders");
  await flushLogs();
  return Response.json({ ok: true, ...r });
}
