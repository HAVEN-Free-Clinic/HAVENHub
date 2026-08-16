import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { prisma } from "@/platform/db";
import { getObject } from "@/platform/storage";
import { can } from "@/platform/rbac/engine";
import { isCourseAssignedTo } from "@/modules/learning/services/enrollment";
import { contentTypeFor } from "@/modules/learning/services/packages";

type RouteContext = { params: Promise<{ courseId: string; path: string[] }> };

/**
 * How long a browser may reuse a package file without asking again.
 *
 * This route used to send `max-age=0, must-revalidate`, which meant every asset
 * of every SCO the learner opened came back through five database queries and an
 * R2 read, forever (audit 14, scorm-asset-route-uncacheable). Five minutes covers
 * moving between SCOs and re-entering a course in one sitting, which is where the
 * repeat requests actually come from, while keeping the window in which a
 * re-uploaded package could still serve stale files short enough that a reload
 * fixes it.
 *
 * `private`, never `public`: these packages sit behind learning.access and the
 * authorization above must run on every request that reaches the server. The
 * cost of `private` is that the copy lives in ONE browser profile's cache and
 * browsers do not partition that by application user, so a second person signing
 * in on the same machine could read a cached asset without being assigned the
 * course. Accepted deliberately: the content is training courseware, no PHI and
 * no per-learner data, and the alternative (no caching at all) is what this
 * finding is about. Do NOT reach for `public` or a CDN here -- that would put
 * gated content on a shared cache with no authorization at all.
 */
const CACHE_SECONDS = 300;

function cacheHeaders(etag: string | null): Record<string, string> {
  return {
    "Cache-Control": `private, max-age=${CACHE_SECONDS}, must-revalidate`,
    ...(etag ? { ETag: etag } : {}),
  };
}

/**
 * GET /learning/play/[courseId]/[...path]
 *
 * Streams one file of a course's SCORM package, same-origin, so the SCORM API on
 * the player page is reachable from the iframe. Access: the signed-in person must
 * be assigned the course, or hold learning.manage_courses (admin preview). 404 is
 * returned for missing files and unauthorized access alike (no enumeration).
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const session = await auth();
  if (!session?.personId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, path } = await context.params;

  // One round-trip stage instead of three. None of these reads depends on
  // another's result, and this handler runs once PER FILE: a single course page
  // pulls the SCO page plus its scripts, stylesheets, images and fonts, so the
  // sequential version paid three serial database waits dozens of times over for
  // one screen (audit 14, scorm-asset-route-uncacheable). Wasted work in the
  // rare rejected cases (a revoked session still costs the assignment query) is
  // the trade; nothing is returned from them.
  const [person, assigned, course] = await Promise.all([
    getActivePerson(session.personId),
    isCourseAssignedTo(session.personId, courseId),
    // Files are stored under a per-upload versioned prefix (scorm/<courseId>/<key>/)
    // so a re-ingest never overwrites the live package before the DB commit (F17).
    // Pre-migration packages have no key and live at the flat prefix; fall back to it.
    // A courseId carrying ".." simply matches no row here (parameterized), and the
    // traversal guard below still runs before it reaches an object key.
    prisma.course.findUnique({ where: { id: courseId }, select: { scormBlobKey: true } }),
  ]);
  if (!person) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const allowed = assigned || (await can(person.id, "learning.manage_courses"));
  if (!allowed) return Response.json({ error: "Not found" }, { status: 404 });

  // Build the relative path; refuse traversal in either the courseId or the path.
  const rel = path.join("/");
  if (courseId.includes("..") || rel.split("/").some((seg) => seg === "..")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const objectKey = course?.scormBlobKey
    ? `scorm/${courseId}/${course.scormBlobKey}/${rel}`
    : `scorm/${courseId}/${rel}`;

  // The package's contents at a given blobKey are immutable: ingest stages every
  // re-upload under a FRESH key and only then repoints the course, so the key is
  // an exact content version for every file under it. That makes a strong ETag
  // free, and lets a revalidation answer 304 without reading the object out of
  // R2 at all. Legacy packages (no key) predate the versioned prefix and can be
  // overwritten in place, so they get no validator.
  const etag = course?.scormBlobKey ? `"${course.scormBlobKey}"` : null;
  if (etag && request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: cacheHeaders(etag) });
  }

  const buf = await getObject(objectKey);
  if (!buf) return Response.json({ error: "Not found" }, { status: 404 });

  const bytes = new Uint8Array(buf);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentTypeFor(rel),
      "Content-Length": String(buf.byteLength),
      ...cacheHeaders(etag),
      // This is the one route that serves EXECUTABLE uploaded content, and the
      // player frames it with allow-same-origin (SCORM 1.2 needs window.parent.API),
      // so package script runs on the app's origin with the learner's cookie.
      // Without a CSP, a coordinator holding only learning.manage_courses could
      // upload a package that reads any page the learner can read and POSTs it
      // off-origin. default-src/connect-src 'self' closes every off-origin load
      // and send; form-action 'none' closes the form channel. Matches the header
      // convention of the other six user-content routes.
      //
      // Residual: same-origin reads by package script are still possible, and a
      // determined payload could self-navigate the iframe to exfiltrate. Full
      // isolation needs the package served from a separate origin with the
      // scorm-again cross-frame postMessage shim (see audit 2026-07-23 #4).
      "Content-Security-Policy":
        "default-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
