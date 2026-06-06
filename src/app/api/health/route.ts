import { NextResponse } from "next/server";
import { prisma } from "@/platform/db";
import { outboxStats } from "@/platform/outbox";

export async function GET() {
  let db = false;
  let worker = { ok: false };
  let outbox = { pending: 0, failed: 0 };
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
    const heartbeat = await prisma.workerHeartbeat.findUnique({ where: { id: "mirror-worker" } });
    const workerOk = !!heartbeat && Date.now() - heartbeat.beatAt.getTime() < 90_000;
    worker = { ok: workerOk };
    outbox = await outboxStats();
  } catch {
    // fall through; db stays false, worker and outbox stay at defaults
  }
  return NextResponse.json(
    { ok: db, db, worker, outbox },
    { status: db ? 200 : 503 }
  );
}
