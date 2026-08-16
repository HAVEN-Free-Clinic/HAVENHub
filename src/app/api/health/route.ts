import { NextResponse } from "next/server";
import { prisma } from "@/platform/db";

export async function GET() {
  let db = false;
  // Coarse "is a mailbox configured" flag so an uptime monitor can alert when the
  // mailer was never connected. Kept DB-only (no Graph token probe) to stay fast and
  // cheap for frequent pings; live token health surfaces on /admin/email. `ok`/status
  // gate on the DB only -- a missing mailer is informational, not a hard outage.
  //
  // `mailerConfigured` rather than `mailer`, because the old name overclaimed and
  // an uptime monitor watching it stayed green through a dead refresh token: the
  // row exists from the moment someone connects the mailbox and is never removed
  // when Entra stops honouring it (audit 14, OBS-04). This answers "was a mailbox
  // ever connected", which is all a row's existence can answer. Whether it can
  // still SEND is a Graph round trip, deliberately not on this path.
  let mailerConfigured = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
    const cred = await prisma.mailCredential.findUnique({ where: { id: "mailer" }, select: { id: true } });
    mailerConfigured = cred != null;
  } catch {
    // fall through; db stays false
  }
  return NextResponse.json(
    {
      ok: db,
      db,
      mailerConfigured,
      // Kept so an existing monitor's JSON path does not break, but it means the
      // same thing it always did rather than what its name implied.
      mailer: mailerConfigured,
    },
    { status: db ? 200 : 503 }
  );
}
