/**
 * GET /credential/[token]/photo -- the photo on a public credential page.
 *
 * Keyed on the credential's unguessable publicToken rather than a personId, so
 * the public surface never exposes an internal id and cannot be enumerated. It
 * inherits publish, unpublish, and revoke gating for free: unpublishing nulls
 * the token, which makes this 404 alongside the page itself.
 *
 * Unlike the in-app route, this one reads stored bytes only and NEVER triggers a
 * Yalies pull. An anonymous endpoint that can cause outbound third-party fetches
 * is an abuse vector: anyone could drive our server's traffic to a third party by
 * hammering a public URL.
 *
 * The photo is resolved live rather than frozen into ServiceCredential.record,
 * so a member removing their photo clears it here immediately. record is
 * deliberately frozen at issue time and never recomputed; the photo deliberately
 * does not follow that rule, because opt-out has to be real.
 */
import { isDbUnreachableError, prisma } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import { PHOTO_CONTENT_TYPE } from "@/platform/photos";
import { getObject } from "@/platform/storage";

type RouteContext = { params: Promise<{ token: string }> };

/** Raster only, so nosniff plus a null CSP neutralizes any active content. */
const IMAGE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
};

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { token } = await context.params;

  // Mirrors the isDbUnreachableError -> 503 pattern in notifications/route.ts
  // and calendar/[token]/route.ts. A .catch(() => null) here would turn "we
  // cannot check right now" into "this credential does not exist", and a 404
  // is far more cacheable than a 503 -- an outage could get cached by a CDN
  // or browser and outlive itself. Non-connectivity errors still rethrow, so
  // a real bug in the lookup stays visible instead of being swallowed as 503.
  let credential;
  try {
    credential = await prisma.serviceCredential.findUnique({
      where: { publicToken: token },
      select: { revokedAt: true, person: { select: { id: true, photoKey: true } } },
    });
  } catch (err) {
    if (isDbUnreachableError(err)) {
      log.warn("[credential-photo] database unreachable resolving token", errorAttrs(err));
      return new Response("Service Unavailable", { status: 503 });
    }
    throw err;
  }

  if (!credential || credential.revokedAt || !credential.person.photoKey) {
    return new Response("Not found", { status: 404 });
  }

  // Storage misses degrade to 404 rather than 503: a missing object is a data
  // fact ("no photo here"), not a connectivity fact, so caching it is fine.
  const bytes = await getObject(credential.person.photoKey).catch(() => null);
  if (!bytes) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": PHOTO_CONTENT_TYPE,
      // The page renders ?v=<photoVersion>, so a changed photo is a changed URL.
      "Cache-Control": "public, max-age=31536000, immutable",
      ...IMAGE_SECURITY_HEADERS,
    },
  });
}
