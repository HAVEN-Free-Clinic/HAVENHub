/**
 * GET /api/people/[personId]/photo -- in-app member photo serving.
 *
 * The seam that keeps the Yalies API off every render path. Pages emit an <img>
 * pointing here and never await a third party themselves; a slow Yalies degrades
 * to one slow-loading avatar instead of a slow page. This is also the only route
 * that ever triggers a lazy Yalies pull, and even here only for a self-view (see
 * the `allowPull` call below): an admin browsing the roster must not turn one
 * page render into dozens of outbound calls to a third party with no published
 * rate limit, on behalf of people who never asked to be looked at. The public
 * credential photo route never triggers a pull at all, for the same reason in
 * a more exposed (unauthenticated) setting.
 *
 * Uses auth()/can() rather than requirePermission because the session helpers
 * redirect on denial, and an <img> request needs a status code.
 */
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { isDbUnreachableError, prisma } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import { initialsSvg, resolvePhoto } from "@/platform/photos";
import { can } from "@/platform/rbac/engine";

type RouteContext = { params: Promise<{ personId: string }> };

/** Raster/SVG only, so nosniff plus a null CSP neutralizes any active content. */
const IMAGE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
};

/** The initials placeholder, never cached so a real photo can replace it. */
async function initialsResponse(personId: string): Promise<Response> {
  const person = await prisma.person
    .findUnique({ where: { id: personId }, select: { name: true } })
    .catch(() => null);

  return new Response(initialsSvg(person?.name ?? null), {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "no-store",
      ...IMAGE_SECURITY_HEADERS,
    },
  });
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { personId } = await context.params;

  const session = await auth();
  if (!session?.personId) return new Response("Unauthorized", { status: 401 });

  // The JWT lives 7 days and does not revalidate Person.status on its own, so an
  // offboarded person must be rejected here rather than trusted from the token.
  // Same convention as the other routes that combine auth() with can() directly.
  //
  // This is the revocation check, so a database blip must never resolve as
  // "still active" -- unlike resolvePhoto below, there is no safe fallback
  // content here, only a safe status code. It also runs on every avatar on
  // every page (this route has far more blast radius than the one-off
  // routes this pattern is copied from), so an unguarded call would turn one
  // Neon blip into a 500 storm across the whole app instead of one degraded
  // response. The guard has to live here at the route boundary, not inside
  // getActivePerson itself, because only the caller knows 503 is the right
  // answer for this particular lookup; other callers of getActivePerson may
  // want different handling. Non-connectivity errors still rethrow, so a
  // real bug in the lookup stays visible instead of being swallowed as 503.
  let person;
  try {
    person = await getActivePerson(session.personId);
  } catch (err) {
    if (isDbUnreachableError(err)) {
      log.warn("[people-photo] database unreachable revalidating the caller", errorAttrs(err));
      return new Response("Service Unavailable", { status: 503 });
    }
    throw err;
  }
  if (!person) return new Response("Forbidden", { status: 403 });

  const isSelf = person.id === personId;
  if (!isSelf && !(await can(person.id, "admin.manage_people"))) {
    return new Response("Forbidden", { status: 403 });
  }

  // A photo failure must never break the surface asking for it. Reads degrade to
  // initials, consistent with the app's posture when the database is unreachable.
  // allowPull is restricted to self-views (see the route's own doc comment): an
  // admin looking at someone else's photo gets whatever is already stored and
  // never triggers an outbound Yalies call.
  const photo = await resolvePhoto(personId, undefined, { allowPull: isSelf }).catch((err) => {
    log.warn("[people-photo] resolvePhoto failed; degrading to initials", errorAttrs(err));
    return null;
  });
  if (!photo) return initialsResponse(personId);

  return new Response(new Uint8Array(photo.bytes), {
    status: 200,
    headers: {
      "Content-Type": photo.contentType,
      // Safe despite the long max-age: the URL carries ?v=<photoVersion>, which
      // increments on every set and every removal.
      "Cache-Control": "private, max-age=31536000, immutable",
      ...IMAGE_SECURITY_HEADERS,
    },
  });
}
