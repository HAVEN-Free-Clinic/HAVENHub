import { randomUUID } from "node:crypto";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { prisma } from "@/platform/db";
import { supportsPresignedUpload } from "@/platform/storage";
import { presignPut } from "@/platform/storage/r2";
import { videoKeyPrefix } from "@/modules/learning/services/video-courses";
import { MAX_CAPTIONS_BYTES, MAX_VIDEO_BYTES, VIDEO_CONTENT_TYPES } from "@/modules/learning/engine/video-limits";

const VIDEO_TYPES = new Set<string>(VIDEO_CONTENT_TYPES);
/** Browsers disagree about .vtt: some say text/vtt, some nothing at all. */
const CAPTION_TYPES = new Set(["text/vtt", "application/octet-stream", ""]);

/** A 2 GB upload on a slow connection takes a while; the URL must outlive it. */
const EXPIRES_IN_SECONDS = 6 * 60 * 60;

function sanitizeFilename(name: string, fallback: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/\.{2,}/g, "_")
      .slice(0, 100) || fallback
  );
}

function bad(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/**
 * POST /api/learning/video-upload-url
 *
 * Signs a PUT so a course manager's browser can send a course video (or its
 * captions) straight to R2, the same way the SCORM upload does: a recording is
 * far past any function's request-body limit. The browser then registers the
 * key with a server action, which checks the key's namespace and that the
 * object really arrived.
 *
 * With no R2 (local dev and tests) it hands back the same-origin
 * /api/learning/video-upload-local URL instead, so the client runs one code
 * path everywhere.
 */
export async function POST(request: Request): Promise<Response> {
  let body: { courseId?: unknown; kind?: unknown; filename?: unknown; contentType?: unknown; size?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad("Malformed request body.", 400);
  }
  const { courseId, kind, filename, contentType, size } = body;
  if (
    typeof courseId !== "string" ||
    (kind !== "video" && kind !== "captions") ||
    typeof filename !== "string" ||
    typeof contentType !== "string" ||
    typeof size !== "number" ||
    !Number.isFinite(size)
  ) {
    return bad("Malformed request body.", 400);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(courseId)) return bad("Invalid course reference.", 400);

  if (kind === "video") {
    if (!VIDEO_TYPES.has(contentType)) return bad("Upload an MP4 video.", 400);
    if (size <= 0 || size > MAX_VIDEO_BYTES) return bad("That video is too large (max 5 GB).", 400);
  } else {
    if (!CAPTION_TYPES.has(contentType) || !/\.vtt$/i.test(filename)) return bad("Upload a .vtt captions file.", 400);
    if (size <= 0 || size > MAX_CAPTIONS_BYTES) return bad("That captions file is too large (max 5 MB).", 400);
  }

  const session = await auth();
  if (!session?.personId) return bad("Unauthorized", 403);
  const person = await getActivePerson(session.personId);
  if (!person || !(await can(person.id, "learning.manage_courses"))) return bad("Unauthorized", 403);

  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { kind: true } });
  if (course?.kind !== "VIDEO") return bad("This is not a video course.", 400);

  const name = sanitizeFilename(filename, kind === "video" ? "video.mp4" : "captions.vtt");
  const key = `${videoKeyPrefix(courseId)}${randomUUID()}-${name}`;
  const storedType = kind === "video" ? contentType : "text/vtt";

  if (!supportsPresignedUpload) {
    return Response.json({
      url: `/api/learning/video-upload-local?key=${encodeURIComponent(key)}`,
      key,
      contentType: storedType,
    });
  }
  const url = await presignPut(key, storedType, EXPIRES_IN_SECONDS);
  return Response.json({ url, key, contentType: storedType });
}
