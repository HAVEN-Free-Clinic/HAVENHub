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
// The shared leaf, not the "@/platform/photos" barrel: that barrel re-exports
// service.ts (Prisma) and normalize.ts (sharp) alongside this constant, which
// would bundle both a database client and a native image library into this
// anonymous, unauthenticated route for a single string it never needs.
import { PHOTO_CONTENT_TYPE } from "@/platform/photos/shared";
import { getObject } from "@/platform/storage";

type RouteContext = { params: Promise<{ token: string }> };

/** Raster only, so nosniff plus a null CSP neutralizes any active content. */
const IMAGE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
};

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { token } = await context.params;

  // Defensive: a Next.js dynamic segment cannot match an empty path today, so
  // this cannot currently be reached with a falsy token. Kept anyway, mirroring
  // getCredentialByToken's own guard, so a future refactor that reaches this
  // handler by another path cannot pass an empty or undefined token into a
  // unique lookup.
  if (!token) return new Response("Not found", { status: 404 });

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

  // getObject (see r2.ts) resolves null only for a genuine not-found -- NoSuchKey
  // or a bare 404 -- and rethrows everything else on purpose, so a 500 or a
  // credentials error is never mistaken for "file not found". A null return
  // here is a data fact ("no photo here") and stays a 404; a thrown error is a
  // connectivity fact and must not collapse into that same 404, for the same
  // caching reason as the credential lookup above.
  let bytes: Buffer | null;
  try {
    bytes = await getObject(credential.person.photoKey);
  } catch (err) {
    log.warn("[credential-photo] object storage unreachable reading photo", errorAttrs(err));
    return new Response("Service Unavailable", { status: 503 });
  }
  if (!bytes) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": PHOTO_CONTENT_TYPE,
      // NOT a long immutable cache, even though the URL carries ?v=<photoVersion>:
      // this is a PUBLIC, unauthenticated response, so a long max-age would let
      // any viewer's browser (or an intermediate cache) keep serving the photo
      // long after the member removes it or unpublishes the credential entirely,
      // which is exactly the removal this design's opt-out promises is real.
      // Matches the branding asset route's convention for a versioned public
      // asset (see src/app/api/branding/[asset]/route.ts) rather than the
      // in-app photo route's, which is "private" (scoped to one already-viewing
      // browser) and versioned the same way but does not carry this exposure.
      "Cache-Control": "public, max-age=300, must-revalidate",
      ...IMAGE_SECURITY_HEADERS,
    },
  });
}
