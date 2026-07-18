/**
 * Daily recruitment review digest. Notifies each active department director who
 * has applications awaiting review in their department(s) (volunteer apps routed
 * to them and still undecided, plus director-track apps ranking their dept with
 * no decided interview yet). Directors with nothing to review are not pinged.
 *
 * Triggered DAILY by an EXTERNAL scheduler (cron-job.org) hitting this path with
 * `Authorization: Bearer $CRON_SECRET`, not by Vercel Cron (vercel.json declares
 * no crons; see docs/cron-jobs.md). This route only ENQUEUES; delivery is handled
 * by the per-tick /api/cron/email drainer (and the post-enqueue flush).
 */
import { authorizeCron } from "@/platform/cron";
import { recordCronHeartbeat } from "@/platform/cron-heartbeat";
import { runRecruitmentReviewDigest } from "@/modules/recruitment/services/review-digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });

  const r = await runRecruitmentReviewDigest();

  await recordCronHeartbeat("recruitment-review-digest");
  return Response.json({ ok: true, ...r });
}
