import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { getObject } from "@/platform/storage";
import { getApplication } from "@/modules/recruitment/services/submissions";
import { reviewScope, canViewApplication } from "@/modules/recruitment/services/review";
import { can } from "@/platform/rbac/engine";
import { INLINE_SAFE_MIME_TYPES } from "@/modules/recruitment/services/file-preview";

type RouteContext = {
  params: Promise<{ applicationId: string; key: string }>;
};

type StoredFile = { storedName?: string; fileName?: string; mimeType?: string };

/**
 * GET /api/recruitment/applications/[applicationId]/files/[key]
 *
 * Serves a FILE-type answer (resume/CV, etc.) an applicant uploaded, gated to
 * reviewers who may see that application. Route handlers cannot call redirect(),
 * so auth failures return JSON error responses.
 *
 * Security:
 *   - Requires a valid session matched to an active Person.
 *   - Authorization is the shared canViewApplication() check, identical to the
 *     applicant detail page that links here: SRR/review_all, cycle managers, and
 *     committee scorers see any application; a scope-director sees a VOLUNTEER
 *     application routed to their department, or a DIRECTOR-track application
 *     that ranked their department. (Previously this route omitted the scorer
 *     and routed-director branches, 404-ing committee scorers on every file.)
 *   - The stored object key is built from the application's own cycleId and the
 *     answer's storedName (both from the DB), never from user input, so no path
 *     traversal is possible via the URL `key`.
 *   - Both "missing" and "not allowed" return 404, so an unauthorized viewer
 *     cannot tell a file exists from one that doesn't.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const session = await auth();
  if (!session?.personId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const activePerson = await getActivePerson(session.personId);
  if (!activePerson) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { applicationId, key } = await context.params;

  // --- Load the application, then verify the reviewer may see it ---
  const app = await getApplication(applicationId);
  let allowed = false;
  if (app) {
    const [scope, managesCycles, canScore] = await Promise.all([
      reviewScope(activePerson.id),
      can(activePerson.id, "recruitment.manage_cycles"),
      can(activePerson.id, "recruitment.score"),
    ]);
    allowed = canViewApplication(app, { scope, managesCycles, canScore });
  }
  if (!app || !allowed) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // --- Resolve the requested FILE answer (storedName/mimeType come from the DB) ---
  const answers = (app.answers ?? {}) as Record<string, unknown>;
  const val = answers[key];
  const file: StoredFile | null = val && typeof val === "object" ? (val as StoredFile) : null;
  if (!file?.storedName || !file.mimeType) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const buf = await getObject(`recruitment/${app.cycleId}/${file.storedName}`);
  if (!buf) {
    console.error(
      "[recruitment/files] file missing in storage for application",
      applicationId,
      "key",
      key,
      "stored name",
      file.storedName,
    );
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
  const renderInline = inline && INLINE_SAFE_MIME_TYPES.has(file.mimeType);
  const rawName = file.fileName ?? "file";
  const safeFileName = rawName.replace(/[\x00-\x1f\x7f"]/g, "").trim() || "file";
  const encodedFileName = encodeURIComponent(rawName);

  return new Response(fileBytes, {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `${renderInline ? "inline" : "attachment"}; filename="${safeFileName}"; filename*=UTF-8''${encodedFileName}`,
      "Content-Length": String(fileByteLength),
      // Defense-in-depth: never sniff a different type than declared, and deny the
      // served document any ability to load or execute sub-resources.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
