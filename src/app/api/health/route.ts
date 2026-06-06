import { NextResponse } from "next/server";
import { prisma } from "@/platform/db";

export async function GET() {
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    // fall through — db stays false
  }
  return NextResponse.json(
    { ok: db, db },
    { status: db ? 200 : 503 }
  );
}
