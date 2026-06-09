/**
 * Daily HIPAA compliance reminders + director escalations.
 * Replaces the worker's REMINDERS_QUEUE (13:00 UTC) schedule. Per-person 7-day
 * dedup lives inside runComplianceReminders, so a daily trigger is safe.
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
