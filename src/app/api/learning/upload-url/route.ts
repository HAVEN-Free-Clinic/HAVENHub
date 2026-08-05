import { randomUUID } from "node:crypto";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { supportsPresignedUpload } from "@/platform/storage";
import { presignPut } from "@/platform/storage/r2";

/** Max COMPRESSED upload size. Mirrors the client-side check in UploadPackageForm. */
const MAX_UPLOAD_BYTES = 75 * 1024 * 1024; // 75 MB

/** Browsers disagree about the zip MIME type, so accept the three we see. */
const ALLOWED_CONTENT_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
]);

/** Long enough for a slow 75 MB upload, short enough that a leaked URL ages out. */
const EXPIRES_IN_SECONDS = 600;

/**
 * Reduce a browser-supplied filename to safe key characters. The uploaded name
 * is cosmetic (ingest reads the key, not the name), so replacing rather than
 * rejecting keeps unicode filenames working.
 *
 * "." is in the allowed set (so extensions like ".zip" survive), which means a
 * plain character-class replace leaves ".." path-traversal markers intact --
 * "../../etc/passwd" becomes ".._.._etc_passwd", still a traversal segment.
 * Collapsing runs of two or more dots afterward closes that gap.
 */
function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/\.{2,}/g, "_")
      .slice(0, 100) || "package.zip"
  );
}

type Body = {
  courseId?: unknown;
  filename?: unknown;
  contentType?: unknown;
  size?: unknown;
};

function bad(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/**
 * POST /api/learning/upload-url
 *
 * Issues a short-lived presigned PUT URL so a course manager's browser can send a
 * SCORM .zip DIRECTLY to R2, bypassing the 4.5 MB Vercel function request-body
 * limit. The browser then calls ingestUploadedPackageAction with the returned
 * key; the server unzips it from storage. Only learning.manage_courses holders
 * can obtain a URL.
 *
 * A presigned PUT cannot itself cap the request body, so size is defended in
 * three layers: the client checks before asking, this route checks the declared
 * size before signing, and ingest checks the actual object before unzipping.
 */
export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return bad("Malformed request body.", 400);
  }

  const { courseId, filename, contentType, size } = body;
  if (
    typeof courseId !== "string" ||
    typeof filename !== "string" ||
    typeof contentType !== "string" ||
    typeof size !== "number" ||
    !Number.isFinite(size)
  ) {
    return bad("Malformed request body.", 400);
  }

  // courseId is interpolated straight into the object key, so it has to be
  // constrained to key-safe characters before it gets there.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(courseId)) {
    return bad("Invalid course reference.", 400);
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return bad("Upload a .zip SCORM package.", 400);
  }
  if (size <= 0 || size > MAX_UPLOAD_BYTES) {
    return bad("That package is too large (max 75 MB).", 400);
  }

  const session = await auth();
  if (!session?.personId) return bad("Unauthorized", 403);
  const person = await getActivePerson(session.personId);
  if (!person || !(await can(person.id, "learning.manage_courses"))) {
    return bad("Unauthorized", 403);
  }

  // Presigning only makes sense against R2: r2.ts's presignPut builds its
  // request from R2_BUCKET/R2_ACCOUNT_ID/credentials, all undefined once R2 is
  // rolled back to Blob. UploadPackageForm already gates its direct-upload path
  // on this same flag and should never reach here in that state, but a stale
  // client or a direct request still can -- fail cleanly instead of building a
  // request against undefined credentials.
  if (!supportsPresignedUpload) {
    return bad(
      "Direct uploads are unavailable right now. Please try again shortly or contact support.",
      503
    );
  }

  const key = `scorm-uploads/${courseId}/${randomUUID()}-${sanitizeFilename(filename)}`;
  const url = await presignPut(key, contentType, EXPIRES_IN_SECONDS);
  return Response.json({ url, key });
}
