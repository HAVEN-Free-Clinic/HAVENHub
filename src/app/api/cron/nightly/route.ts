/**
 * Nightly maintenance: recompute compliance statuses (enqueues mirror changes)
 * then reconcile People against Airtable. Replaces the worker's
 * COMPLIANCE_REFRESH_QUEUE (05:30) and RECONCILE_QUEUE (06:00) schedules.
 */
import { authorizeCron, airtableClient, mirrorTarget } from "@/platform/cron";
import { refreshComplianceMirror } from "@/platform/compliance/mirror-status";
import { reconcilePeople } from "@/platform/airtable/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const enqueued = await refreshComplianceMirror();

  let corrected = 0;
  const client = airtableClient();
  if (client) {
    corrected = await reconcilePeople(client, mirrorTarget());
  }

  return Response.json({ ok: true, enqueued, corrected });
}
