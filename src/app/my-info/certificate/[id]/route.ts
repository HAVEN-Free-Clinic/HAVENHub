import fs from "node:fs/promises";
import path from "node:path";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { getOwnedCertificate } from "@/modules/my-info/services/my-info";
import { config } from "@/platform/config";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * GET /my-info/certificate/[id]
 *
 * Owner-only download. Route handlers cannot call redirect(), so auth failures
 * return JSON error responses instead.
 *
 * Security:
 *   - Requires a valid session with a personId.
 *   - Requires the certificate row to exist AND belong to the session's person.
 *   - storedName comes only from the DB row (never from user input).
 */
export async function GET(
  _request: Request,
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

  // --- Ownership: the cert must exist and belong to this person ---
  const cert = await getOwnedCertificate(activePerson.id, id);
  if (!cert) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // --- Read the file from disk (storedName comes only from the DB row) ---
  const diskPath = path.join(config.UPLOAD_DIR, cert.storedName);

  let fileBytes: ArrayBuffer;
  let fileByteLength: number;
  try {
    const buf = await fs.readFile(diskPath);
    fileBytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    fileByteLength = buf.byteLength;
  } catch (err) {
    console.error(
      "[my-info/certificate] file missing on disk for cert id",
      cert.id,
      "expected path",
      diskPath,
      err
    );
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Strip control characters and double-quotes from the original file name for
  // use in the Content-Disposition header (RFC 5987 / RFC 6266 safety).
  const safeFileName = cert.fileName.replace(/[\x00-\x1f\x7f"]/g, "").trim() || "certificate.pdf";

  return new Response(fileBytes, {
    status: 200,
    headers: {
      "Content-Type": cert.mimeType,
      "Content-Disposition": `attachment; filename="${safeFileName}"`,
      "Content-Length": String(fileByteLength),
    },
  });
}
