/**
 * Daily wallet badge reconciliation.
 *
 * Revokes badges whose term has ended, whose holder has been offboarded, or
 * whose holder no longer holds an ACTIVE membership anywhere (a mid-term roster
 * removal or a self-withdrawal, neither of which touches Person.status). The
 * vendor offers no webhooks and no status endpoint, so this is the only thing
 * that guarantees a badge stops working after the app's best-effort revoke
 * paths (issuance overwrite, offboard) fail at the vendor. Safe to run
 * repeatedly: vendor deletes are documented no-ops, and an already-revoked row
 * is excluded from the sweep's own query.
 *
 * Triggered DAILY by the external scheduler (cron-job.org) with
 * Authorization: Bearer $CRON_SECRET, alongside the other daily jobs.
 */
import { authorizeCron } from "@/platform/cron";
import { recordCronHeartbeat } from "@/platform/cron-heartbeat";
import { log, flushLogs } from "@/platform/logging";
import { sweepWalletPasses } from "@/modules/passport/services/wallet-sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const r = await sweepWalletPasses();

  log.info("[cron/wallet-passes] complete", { ...r });
  await recordCronHeartbeat("wallet-passes");
  await flushLogs();
  return Response.json({ ok: true, ...r });
}
