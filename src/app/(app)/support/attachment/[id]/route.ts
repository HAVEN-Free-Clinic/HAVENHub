import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { getAttachmentForDownload } from "@/modules/support/services/attachments";
import { SupportNotFoundError } from "@/modules/support/services/tech-request";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /support/attachment/[id]
 *
 * Authenticated download of a ticket or comment attachment. Mirrors
 * src/app/(app)/my-info/certificate/[id]/route.ts: route handlers cannot
 * call redirect(), so auth failures return JSON error responses instead, and
 * "not found" covers both a missing row and a denied viewer (no
 * enumeration).
 *
 * Always forces a download (Content-Disposition: attachment) and never
 * renders inline, regardless of the stored mimeType -- an attachment's mime
 * type is user-supplied at upload time, so an inline text/html or
 * image/svg+xml would be a stored-XSS vector served from our origin.
 */
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const session = await auth();
  if (!session?.personId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const person = await getActivePerson(session.personId);
  if (!person) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;

  let file;
  try {
    file = await getAttachmentForDownload(person.id, id);
  } catch (e) {
    if (e instanceof SupportNotFoundError) return Response.json({ error: "Not found" }, { status: 404 });
    throw e;
  }

  // Standalone Uint8Array so the Response owns bytes independent of the
  // source Buffer's backing store (same pattern as the certificate route).
  const bytes = new Uint8Array(file.bytes);

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": contentDisposition(file.filename),
      "Content-Length": String(file.bytes.byteLength),
      // Defense-in-depth: never sniff a different type than declared.
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Always "attachment" (never inline, see the GET doc comment above). The
 * ASCII `filename` parameter is sanitized (control chars and double-quotes
 * removed, per RFC 6266) and falls back to "attachment" if it sanitizes to
 * empty; the RFC 5987 `filename*` parameter carries the full original name.
 */
function contentDisposition(fileName: string): string {
  const safeFileName = fileName.replace(/[\x00-\x1f\x7f"]/g, "").trim() || "attachment";
  const encodedFileName = encodeURIComponent(fileName);
  return `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodedFileName}`;
}
