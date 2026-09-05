import { authorizeCron } from "@/platform/cron";
import { recordCronHeartbeat } from "@/platform/cron-heartbeat";
import { log, flushLogs } from "@/platform/logging";
import { sweepAbandonedDrafts } from "@/modules/recruitment/services/drafts";
import { runDraftReminders } from "@/modules/recruitment/services/draft-reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });
  const reminders = await runDraftReminders();
  const { deleted } = await sweepAbandonedDrafts(30);
  log.info("[cron/recruitment-drafts] complete", { ...reminders, deleted });
  await recordCronHeartbeat("recruitment-drafts");
  await flushLogs();
  return Response.json({ ok: true, ...reminders, deleted });
}
