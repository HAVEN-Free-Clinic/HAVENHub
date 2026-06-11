import { createHmac } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { config } from "@/platform/config";
import { recordAudit } from "@/platform/audit";

/**
 * GET /api/gitbook/auth
 *
 * The "Login URL" for GitBook's custom visitor-authentication backend. GitBook
 * redirects an unauthenticated docs visitor here with a `location` query param
 * (the path within the site they were trying to reach). We:
 *
 *   1. Require a signed-in, active HAVEN person. If there is no session we bounce
 *      through /login, preserving `location`, and GitBook's flow resumes here once
 *      the Yale sign-in completes.
 *   2. Sign a short-lived JWT (HS256) with the site's shared GITBOOK_JWT_KEY and
 *      redirect the visitor back to the published site with `?jwt_token=...`, which
 *      GitBook validates to grant access.
 *
 * The signing key is the HMAC secret used as a raw UTF-8 string, matching GitBook's
 * own jsonwebtoken example, so a hand-rolled HS256 token (no extra dependency) is
 * byte-compatible with what GitBook verifies.
 *
 * Node runtime: uses node:crypto.
 */
export const runtime = "nodejs";

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign an HS256 JWT with the key as a raw UTF-8 secret (GitBook-compatible). */
function signJwt(claims: Record<string, unknown>, key: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", key).update(data).digest("base64url");
  return `${data}.${signature}`;
}

/**
 * Resolve the docs URL to return the visitor to. GitBook's `location` is a path
 * relative to the site base, concatenated onto it (per GitBook's reference
 * implementation). We then hard-assert the result stays on the configured site
 * origin so a crafted `location` can never turn this into an open redirect.
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

  const now = Math.floor(Date.now() / 1000);
  const token = signJwt(
    {
      name: person.name,
      email: person.contactEmail ?? session.user?.email ?? undefined,
      iat: now,
      exp: now + 60 * 60, // 1 hour, matching GitBook's reference backend
    },
    GITBOOK_JWT_KEY
  );

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
