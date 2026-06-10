/**
 * Daily HIPAA compliance reminders + director escalations.
 * Replaces the worker's REMINDERS_QUEUE (13:00 UTC) schedule. Per-person 7-day
 * dedup lives inside runComplianceReminders, so a daily trigger is safe. The
 * email queue is drained at the end so reminders queued this run go out the
 * same day (Hobby plans only allow one daily run per cron).
 */
import { authorizeCron } from "@/platform/cron";
import { runComplianceReminders } from "@/platform/email/reminders";
import { drainEmailQueue } from "@/platform/email/send";
import { emailTransportFromConfig } from "@/platform/email/transport";
import { config } from "@/platform/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const r = await runComplianceReminders();

  const transport = emailTransportFromConfig(config);
  let emails = 0;
  let processed: number;
  do {
    processed = await drainEmailQueue(transport);
    emails += processed;
  } while (processed > 0);

  return Response.json({ ok: true, ...r, emails });
}
