/**
 * Daily HIPAA compliance reminders + director escalations.
 * Replaces the worker's REMINDERS_QUEUE (13:00 UTC) schedule. Per-person 7-day
 * dedup lives inside runComplianceReminders, so a daily trigger is safe.
 *
 * This route only ENQUEUES reminder emails. Delivery is handled by the
 * per-minute /api/cron/email route (the sole queue drainer), which picks these
 * up within ~60s. Draining here would run concurrently with that route at 13:00
 * UTC and double-send.
 */
import { authorizeCron } from "@/platform/cron";
import { runComplianceReminders } from "@/platform/email/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const r = await runComplianceReminders();

  return Response.json({ ok: true, ...r });
}
