import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { config } from "@/platform/config";
import { recordAudit } from "@/platform/audit";
import { mintVisitorToken } from "@/platform/gitbook/visitor-token";
import { scheduleDerivedClaims } from "../schedule-claims";

/**
 * GET /api/gitbook/auth
 *
 * The "Login URL" for GitBook's custom visitor-authentication backend. GitBook
 * redirects an unauthenticated docs visitor here with a `location` query param
 * (the path within the site they were trying to reach). We require a signed-in,
 * active HAVEN person, mint the adaptive visitor JWT (see mintVisitorToken), and
 * redirect the visitor back to the published site with `?jwt_token=...`.
 *
 * Node runtime: mintVisitorToken uses node:crypto.
 */
export const runtime = "nodejs";

/**
 * Resolve the docs URL to return the visitor to. GitBook's `location` is a path
 * relative to the site base. We hard-assert the result stays on the configured
 * site origin so a crafted `location` can never turn this into an open redirect.
 */
function resolveTarget(siteUrl: string, location: string): URL {
  const base = siteUrl.replace(/\/+$/, "");
  const path = location.startsWith("/") ? location : `/${location}`;
  try {
    const target = new URL(`${base}${path}`);
    if (target.origin !== new URL(base).origin) return new URL(base);
    return target;
  } catch {
    return new URL(base);
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const { GITBOOK_JWT_KEY, GITBOOK_SITE_URL } = config;
  if (!GITBOOK_JWT_KEY || !GITBOOK_SITE_URL) {
    return new NextResponse("GitBook visitor authentication is not configured.", {
      status: 503,
    });
  }

  const location = new URL(request.url).searchParams.get("location") ?? "";

  // Require a signed-in, active person. Unauthenticated visitors are sent through
  // the normal Yale sign-in and returned here (with `location` intact) to finish.
  const session = await auth();
  if (!session?.personId) {
    const callbackUrl = `/api/gitbook/auth?location=${encodeURIComponent(location)}`;
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", callbackUrl);
    return NextResponse.redirect(loginUrl);
  }
  const person = await getActivePerson(session.personId);
  if (!person) {
    return NextResponse.redirect(new URL("/welcome", request.url));
  }

  const derived = await scheduleDerivedClaims(person.id);
  const { token } = await mintVisitorToken(person, { email: session.user?.email, derived });

  await recordAudit({
    action: "gitbook.visitor_auth",
    entityType: "Auth",
    entityId: person.id,
    after: { location },
  });

  const target = resolveTarget(GITBOOK_SITE_URL, location);
  target.searchParams.set("jwt_token", token);
  return NextResponse.redirect(target.toString());
}
