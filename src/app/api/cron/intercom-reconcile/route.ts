/**
 * Intercom <-> TechRequest status reconciliation.
 *
 * Direction 3 of the Intercom sync (see
 * docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md) keeps
 * TechRequest.status aligned with its linked Intercom Ticket via webhooks
 * alone. A webhook that Intercom's own retry policy eventually gives up on,
 * or a moment where the Hub's own outbound push fails while Intercom is
 * unreachable, leaves the two systems out of sync with nothing to notice it
 * and no delivery left to retry. This sweep is the backstop: it reads every
 * linked ticket's live Intercom state and reports any disagreement.
 *
 * REPORT-ONLY: this route never writes TechRequest.status. See
 * intercom-reconcile.ts's module doc comment for why -- there is no reliable
 * way to tell, after the fact, which side of a mismatch is the one that
 * actually changed, and a reconciler that confidently overwrites the wrong
 * side is worse than one that only reports.
 *
 * Triggered DAILY by the external scheduler (cron-job.org) with
 * Authorization: Bearer $CRON_SECRET, alongside the other daily jobs. See
 * docs/cron-jobs.md.
 *
 * DB-unreachable posture mirrors the other Intercom-integration routes
 * (src/app/api/support/tickets/events, .../from-conversation): this is
 * externally polled on a schedule the same way those are triggered by
 * Intercom's own webhook delivery, so a Neon blip degrades to 503 (retried by
 * the next scheduled tick) rather than surfacing as an unhandled 500.
 */
import { authorizeCron } from "@/platform/cron";
import { recordCronHeartbeat } from "@/platform/cron-heartbeat";
import { isDbUnreachableError } from "@/platform/db";
import { log, errorAttrs, flushLogs } from "@/platform/logging";
import { reconcileIntercomTickets } from "@/modules/support/services/intercom-reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  let summary;
  try {
    summary = await reconcileIntercomTickets();
  } catch (err) {
    if (isDbUnreachableError(err)) {
      log.warn("[cron/intercom-reconcile] database unreachable", errorAttrs(err));
      await flushLogs();
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    throw err;
  }

  log.info("[cron/intercom-reconcile] complete", { ...summary });
  await recordCronHeartbeat("intercom-reconcile");
  await flushLogs();
  return Response.json({ ok: true, ...summary });
}
