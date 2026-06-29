// src/app/api/cron/recruitment-drafts/route.ts
import { authorizeCron } from "@/platform/cron";
import { sweepAbandonedDrafts } from "@/modules/recruitment/services/drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });
  const { deleted } = await sweepAbandonedDrafts(30);
  return Response.json({ ok: true, deleted });
}
