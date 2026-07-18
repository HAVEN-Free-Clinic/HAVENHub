import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { prisma } from "@/platform/db";
import { getObject } from "@/platform/storage";
import { contentDisposition } from "@/platform/content-disposition";
import { log } from "@/platform/logging";
import { can } from "@/platform/rbac/engine";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * Mime types we are willing to render inline (preview). Everything else is forced
 * to download even when `?inline=1` is requested -- the stored mimeType comes from
 * the uploader's browser and an inline `text/html` or `image/svg+xml` would be a
 * stored-XSS vector. Mirrors src/app/(app)/my-info/certificate/[id]/route.ts.
 * SVG is intentionally excluded; it can carry script.
 */
const INLINE_SAFE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * GET /api/incidents/attachments/[id]
 *
 * Authorized download for an incident report attachment. Route handlers
 * cannot call redirect(), so auth failures return JSON error responses.
 *
 * Security:
 *   - Requires a valid session with a personId, matched to an active Person.
 *   - Requires the attachment to exist AND either the viewer to be the report's
 *     reporter (owner), or a holder of incidents.manage who is NOT a linked
 *     subject of the report -- a subject who also holds incidents.manage can
 *     never download evidence about themselves, mirroring the report read paths.
 *   - Both "missing" and "not allowed" return 404, so an unauthorized viewer
 *     cannot tell an attachment exists from one that doesn't.
 *   - storedName comes only from the DB row (never from user input).
 */
export async function GET(
  request: Request,
  context: RouteContext
): Promise<Response> {
  // --- Auth: require a signed-in, active person ---
  const session = await auth();
  if (!session?.personId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const activePerson = await getActivePerson(session.personId);
  if (!activePerson) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  // --- Access check: load the attachment by id then verify viewer may access it ---
  const attachment = await prisma.incidentReportAttachment.findUnique({
    where: { id },
    include: { report: { select: { reporterId: true, subjects: { select: { personId: true } } } } },
  });
  // Access mirrors the report read paths: the reporter (owner) always sees the
  // evidence; a manager sees it only when they are NOT a linked subject of the
  // report, so a subject who also holds incidents.manage can never download
  // evidence about themselves.
  let allowed = false;
  if (attachment) {
    const isOwner = attachment.report.reporterId === activePerson.id;
    const isSubject = attachment.report.subjects.some((s) => s.personId === activePerson.id);
    allowed = isOwner || (!isSubject && (await can(activePerson.id, "incidents.manage")));
  }
  if (!attachment || !allowed) {
    // Return 404 in both cases to avoid leaking whether the attachment exists.
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // --- Read the file from storage (storedName comes only from the DB row) ---
  const buf = await getObject(attachment.storedName);
  if (!buf) {
    log.error("[incidents/attachments] file missing in storage", {
      attachmentId: attachment.id,
      storedName: attachment.storedName,
    });
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // Copy into a standalone Uint8Array (a valid BodyInit) so the Response owns
  // bytes independent of the source Buffer's backing store.
  const fileBytes = new Uint8Array(buf);
  const fileByteLength = buf.byteLength;

  // `?inline=1` previews the file in-page; the default remains a download.
  // Inline rendering is additionally gated to a safe mime allowlist so a
  // maliciously-typed stored file can never execute script in our origin.
  const inline = new URL(request.url).searchParams.get("inline") === "1";
  const renderInline = inline && INLINE_SAFE_MIME_TYPES.has(attachment.mimeType);

  return new Response(fileBytes, {
    status: 200,
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Disposition": contentDisposition(attachment.fileName, {
        inline: renderInline,
        fallbackName: "attachment",
      }),
      "Content-Length": String(fileByteLength),
      // Defense-in-depth: never sniff a different type than declared, and deny the
      // served document any ability to load or execute sub-resources.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
