/**
 * Weekly shift reminders. Sent Monday mornings to everyone scheduled for the
 * upcoming Saturday clinic day.
 *
 * Triggered WEEKLY on Mondays at 13:00 UTC by an EXTERNAL scheduler
 * (cron-job.org) hitting this path with `Authorization: Bearer $CRON_SECRET`,
 * not by Vercel Cron; this route is intentionally absent from vercel.json (see
 * docs/cron-jobs.md). This route only ENQUEUES; delivery is handled by the
 * per-minute /api/cron/email drainer within ~60s. Draining here would run
 * concurrently with that route and double-send.
 */
import { authorizeCron } from "@/platform/cron";
import { runShiftReminders } from "@/platform/email/shift-reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const r = await runShiftReminders();

  return Response.json({ ok: true, ...r });
}
