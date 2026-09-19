import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { getObject } from "@/platform/storage";
import { authorizeVideoFile } from "@/modules/learning/services/video-progress";

type RouteContext = { params: Promise<{ videoId: string }> };

/**
 * GET /api/learning/video/[videoId]/captions
 *
 * The video's WebVTT captions. Served same-origin rather than redirected to
 * R2 like the video itself, because a <track> is fetched in CORS mode and a
 * cross-origin captions file would need a CORS policy on the bucket. The file
 * is small, so proxying it costs nothing. Same authorization as the video.
 */
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const session = await auth();
  if (!session?.personId) return new Response("Unauthorized", { status: 401 });
  const person = await getActivePerson(session.personId);
  if (!person) return new Response("Unauthorized", { status: 401 });

  const { videoId } = await context.params;
  const file = await authorizeVideoFile(person.id, videoId);
  if (!file?.captionsKey) return new Response("Not found", { status: 404 });
  const bytes = await getObject(file.captionsKey);
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "private, max-age=300" },
  });
}
