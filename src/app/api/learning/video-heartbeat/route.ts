import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { isSerializationError } from "@/platform/db";
import { recordSectionHeartbeat } from "@/modules/learning/services/video-progress";
import { LearningAuthError, LearningValidationError } from "@/modules/learning/services/errors";

/**
 * POST /api/learning/video-heartbeat
 *
 * The video player's progress report: { courseId, sectionId, reachedSeconds }.
 * A route rather than a server action for the same reason as the SCORM
 * beacon (persist-cmi): the player also reports on pagehide through
 * navigator.sendBeacon, which survives the page going away where an action's
 * fetch is cancelled. The person comes from the session cookie, never the
 * body, and the service decides how much of the claim real time allows.
 *
 * Answers with the credited position so the player can pull its seek limit
 * back to what the server accepted.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.personId) return new Response("Unauthorized", { status: 401 });
  const person = await getActivePerson(session.personId);
  if (!person) return new Response("Unauthorized", { status: 401 });

  let body: { courseId?: unknown; sectionId?: unknown; reachedSeconds?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (typeof body.courseId !== "string" || typeof body.sectionId !== "string" || typeof body.reachedSeconds !== "number") {
    return new Response("Bad Request", { status: 400 });
  }

  try {
    const result = await recordSectionHeartbeat(person.id, body.courseId, body.sectionId, body.reachedSeconds);
    return Response.json(result);
  } catch (err) {
    if (err instanceof LearningAuthError) return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof LearningValidationError) return Response.json({ error: err.message }, { status: 409 });
    // A write-conflict that outlasted every retry: the heartbeat is droppable,
    // so answer 503 rather than a 500. The player treats a non-ok reply as a
    // dropped beat, and the next beat carries the same furthest point.
    if (isSerializationError(err)) return new Response("Try again", { status: 503 });
    throw err;
  }
}
