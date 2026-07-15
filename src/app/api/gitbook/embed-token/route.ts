import { NextResponse } from "next/server";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { config } from "@/platform/config";
import { mintVisitorToken } from "@/platform/gitbook/visitor-token";

/**
 * GET /api/gitbook/embed-token
 *
 * Issues the adaptive visitor JWT for the in-app GitBook embed (the Help launcher).
 * Unlike /api/gitbook/auth (which 302-redirects into the docs site), this returns the
 * token as JSON so a client component can pass it to <GitBookFrame visitor={{ token }} />.
 * Same claims, same 1h TTL. No per-request audit: the panel opens/refreshes frequently,
 * and the redirect flow already audits real doc visits.
 *
 * Node runtime: mintVisitorToken uses node:crypto.
 */
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const { GITBOOK_JWT_KEY, GITBOOK_SITE_URL } = config;
  if (!GITBOOK_JWT_KEY || !GITBOOK_SITE_URL) {
    return NextResponse.json({ error: "GitBook embed is not configured." }, { status: 503 });
  }

  const session = await auth();
  if (!session?.personId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const person = await getActivePerson(session.personId);
  if (!person) {
    return NextResponse.json({ error: "No active person." }, { status: 403 });
  }

  const { token, expiresAt } = await mintVisitorToken(person, { email: session.user?.email });
  return NextResponse.json({ token, expiresAt }, { headers: { "Cache-Control": "no-store" } });
}
