import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { getLocalObjectRange, getObject, objectSize, presignGetUrl } from "@/platform/storage";
import { authorizeVideoFile } from "@/modules/learning/services/video-progress";
import { parseRange } from "@/modules/learning/engine/byte-range";

type RouteContext = { params: Promise<{ videoId: string }> };

/** How long a signed R2 URL stays good. Each request to this route signs a
 *  fresh one, so this only has to cover one media fetch, not a whole viewing. */
const SIGNED_URL_SECONDS = 60 * 60;

/** Largest slice the local-dev path returns per request. A <video> asks for
 *  "bytes=N-" and happily takes less, then asks again. */
const LOCAL_CHUNK_BYTES = 2 * 1024 * 1024;

/**
 * GET /api/learning/video/[videoId]
 *
 * Plays a course video. Authorization is the course's own (a manager, or a
 * learner the course is open to), checked on every request, so the URL is not
 * a way around it. On R2 the answer is a redirect to a short-lived signed URL:
 * R2 serves the bytes and the Range requests a <video> seeks with, and a 1-2 GB
 * recording never passes through a function. On local disk this route serves
 * the ranges itself. 404 for unknown and unauthorized alike.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const session = await auth();
  if (!session?.personId) return new Response("Unauthorized", { status: 401 });
  const person = await getActivePerson(session.personId);
  if (!person) return new Response("Unauthorized", { status: 401 });

  const { videoId } = await context.params;
  const file = await authorizeVideoFile(person.id, videoId);
  if (!file) return new Response("Not found", { status: 404 });

  const signed = await presignGetUrl(file.storageKey, SIGNED_URL_SECONDS, { contentType: file.contentType });
  if (signed) {
    return new Response(null, {
      status: 302,
      headers: { Location: signed, "Cache-Control": "private, no-store" },
    });
  }

  const size = await objectSize(file.storageKey);
  if (size == null) return new Response("Not found", { status: 404 });
  const range = parseRange(request.headers.get("range"), size);
  if (!range) {
    if (request.headers.get("range")) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const whole = await getObject(file.storageKey);
    if (!whole) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(whole), {
      status: 200,
      headers: { "Content-Type": file.contentType, "Accept-Ranges": "bytes", "Content-Length": String(size), "Cache-Control": "private, no-store" },
    });
  }
  const end = Math.min(range.end, range.start + LOCAL_CHUNK_BYTES - 1);
  const bytes = await getLocalObjectRange(file.storageKey, range.start, end);
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    status: 206,
    headers: {
      "Content-Type": file.contentType,
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${range.start}-${range.start + bytes.length - 1}/${size}`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
    },
  });
}
