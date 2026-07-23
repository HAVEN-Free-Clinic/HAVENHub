import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { prisma } from "@/platform/db";
import { getObject } from "@/platform/storage";
import { can } from "@/platform/rbac/engine";
import { isCourseAssignedTo } from "@/modules/learning/services/enrollment";
import { contentTypeFor } from "@/modules/learning/services/packages";

type RouteContext = { params: Promise<{ courseId: string; path: string[] }> };

/**
 * GET /learning/play/[courseId]/[...path]
 *
 * Streams one file of a course's SCORM package, same-origin, so the SCORM API on
 * the player page is reachable from the iframe. Access: the signed-in person must
 * be assigned the course, or hold learning.manage_courses (admin preview). 404 is
 * returned for missing files and unauthorized access alike (no enumeration).
 */
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const session = await auth();
  if (!session?.personId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const person = await getActivePerson(session.personId);
  if (!person) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, path } = await context.params;

  const allowed =
    (await isCourseAssignedTo(person.id, courseId)) || (await can(person.id, "learning.manage_courses"));
  if (!allowed) return Response.json({ error: "Not found" }, { status: 404 });

  // Build the relative path; refuse traversal in either the courseId or the path.
  const rel = path.join("/");
  if (courseId.includes("..") || rel.split("/").some((seg) => seg === "..")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Files are stored under a per-upload versioned prefix (scorm/<courseId>/<key>/)
  // so a re-ingest never overwrites the live package before the DB commit (F17).
  // Pre-migration packages have no key and live at the flat prefix; fall back to it.
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { scormBlobKey: true },
  });
  const objectKey = course?.scormBlobKey
    ? `scorm/${courseId}/${course.scormBlobKey}/${rel}`
    : `scorm/${courseId}/${rel}`;

  const buf = await getObject(objectKey);
  if (!buf) return Response.json({ error: "Not found" }, { status: 404 });

  const bytes = new Uint8Array(buf);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentTypeFor(rel),
      "Content-Length": String(buf.byteLength),
      "Cache-Control": "private, max-age=0, must-revalidate",
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
