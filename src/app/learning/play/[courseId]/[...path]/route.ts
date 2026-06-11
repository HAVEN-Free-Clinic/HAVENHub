import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
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

  const buf = await getObject(`scorm/${courseId}/${rel}`);
  if (!buf) return Response.json({ error: "Not found" }, { status: 404 });

  const bytes = new Uint8Array(buf);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentTypeFor(rel),
      "Content-Length": String(buf.byteLength),
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
