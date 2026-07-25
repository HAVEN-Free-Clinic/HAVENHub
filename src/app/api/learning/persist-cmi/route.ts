import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { persistScoCmi, type CmiSnapshot } from "@/modules/learning/services/enrollment";

/**
 * POST /api/learning/persist-cmi
 *
 * Beacon endpoint for the SCORM player. navigator.sendBeacon survives a document
 * unload (tab close), unlike the persistCmiAction server-action fetch, which the
 * browser cancels as the page tears down -- so a completion written as the learner
 * closes the tab after the final SCO is no longer silently lost, which otherwise kept
 * them blocked at /get-started for a course the UI said they had finished (#18).
 *
 * Same authorization + persistence as persistCmiAction: the personId comes from the
 * session cookie sendBeacon carries, never the body, so a crafted payload cannot write
 * another learner's progress. The response is ignored by the beacon; status codes are
 * for logs/tests only.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.personId) return new Response("Unauthorized", { status: 401 });
  const person = await getActivePerson(session.personId);
  if (!person || !(await can(person.id, "learning.access"))) {
    return new Response("Forbidden", { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const b = body as { courseId?: unknown; scoId?: unknown; cmi?: unknown };
  if (typeof b.courseId !== "string" || typeof b.scoId !== "string" || !isCmiSnapshot(b.cmi)) {
    return new Response("Bad Request", { status: 400 });
  }

  await persistScoCmi(person.id, b.courseId, b.scoId, b.cmi);
  return new Response(null, { status: 204 });
}

function isCmiSnapshot(v: unknown): v is CmiSnapshot {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    (c.lessonStatus === null || typeof c.lessonStatus === "string") &&
    (c.scoreRaw === null || typeof c.scoreRaw === "number") &&
    (c.suspendData === null || typeof c.suspendData === "string") &&
    (c.lessonLocation === null || typeof c.lessonLocation === "string")
  );
}
