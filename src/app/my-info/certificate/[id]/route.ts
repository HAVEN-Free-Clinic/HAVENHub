import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { prisma } from "@/platform/db";
import { getObject } from "@/platform/storage";
import { canViewCertificate } from "@/platform/compliance/access";
import { certificateContentDisposition } from "./content-disposition";

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

  // --- Access check: load the cert by id then verify viewer may access it ---
  const cert = await prisma.hipaaCertificate.findUnique({ where: { id } });
  const allowed = cert ? await canViewCertificate(activePerson.id, cert.personId) : false;
  if (!cert || !allowed) {
    // Return 404 in both cases to avoid leaking whether the cert exists
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // --- Read the file from storage (storedName comes only from the DB row) ---
  const buf = await getObject(cert.storedName);
  if (!buf) {
    console.error(
      "[my-info/certificate] file missing in storage for cert id",
      cert.id,
      "stored name",
      cert.storedName
    );
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // Copy into a standalone Uint8Array (a valid BodyInit) so the Response owns
  // bytes independent of the source Buffer's backing store.
  const fileBytes = new Uint8Array(buf);
  const fileByteLength = buf.byteLength;

  // `?inline=1` previews the file in-page (used by the in-app viewer); the default
  // remains a download so existing links are unaffected.
  const inline = new URL(request.url).searchParams.get("inline") === "1";

  return new Response(fileBytes, {
    status: 200,
    headers: {
      "Content-Type": cert.mimeType,
      "Content-Disposition": certificateContentDisposition(cert.fileName, inline),
      "Content-Length": String(fileByteLength),
    },
  });
}
