import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";

/** Max COMPRESSED upload size, enforced by the issued client token. */
const MAX_UPLOAD_BYTES = 75 * 1024 * 1024; // 75 MB

/**
 * POST /api/learning/blob-upload
 *
 * Issues a short-lived client-upload token so a course manager's browser can send
 * a SCORM .zip DIRECTLY to Blob storage, bypassing the 4.5 MB Vercel function
 * request-body limit. The browser then calls ingestUploadedPackageAction with the
 * resulting blob URL; the server unzips it from Blob. Only learning.manage_courses
 * holders can obtain a token.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as HandleUploadBody;
  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        const session = await auth();
        if (!session?.personId) throw new Error("Unauthorized");
        const person = await getActivePerson(session.personId);
        if (!person || !(await can(person.id, "learning.manage_courses"))) {
          throw new Error("Unauthorized");
        }
        return {
          allowedContentTypes: [
            "application/zip",
            "application/x-zip-compressed",
            "application/octet-stream",
          ],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true,
        };
      },
      // No onUploadCompleted: ingest is triggered explicitly by the client after
      // upload() resolves, which also works in local dev where Vercel could not
      // reach the dev server with a callback.
    });
    return Response.json(json);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
