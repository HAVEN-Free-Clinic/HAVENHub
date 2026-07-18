import { NextResponse } from "next/server";
import { prisma } from "@/platform/db";

export async function GET() {
  let db = false;
  // Coarse "is a mailbox configured" flag so an uptime monitor can alert when the
  // mailer was never connected. Kept DB-only (no Graph token probe) to stay fast and
  // cheap for frequent pings; live token health surfaces on /admin/email. `ok`/status
  // gate on the DB only -- a missing mailer is informational, not a hard outage.
  let mailer = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
    const cred = await prisma.mailCredential.findUnique({ where: { id: "mailer" }, select: { id: true } });
    mailer = cred != null;
  } catch {
    // fall through; db stays false
  }
  return NextResponse.json({ ok: db, db, mailer }, { status: db ? 200 : 503 });
}
