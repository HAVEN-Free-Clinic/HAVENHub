import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { putObject, supportsPresignedUpload } from "@/platform/storage";

/**
 * PUT /api/learning/video-upload-local?key=...
 *
 * Local-dev stand-in for a presigned R2 PUT, so the course editor's upload code
 * is identical with and without R2. Refuses outright whenever R2 is configured:
 * in a deployed environment every byte goes browser-to-R2 and nothing should be
 * able to push a video through a function. Buffers the body, which is fine for
 * the small files a developer tests with.
 */
export async function PUT(request: Request): Promise<Response> {
  if (supportsPresignedUpload) return new Response("Not found", { status: 404 });
  const session = await auth();
  if (!session?.personId) return new Response("Unauthorized", { status: 401 });
  const person = await getActivePerson(session.personId);
  if (!person || !(await can(person.id, "learning.manage_courses"))) {
    return new Response("Forbidden", { status: 403 });
  }
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!/^learning-video\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9._-]+$/.test(key) || key.includes("..")) {
    return new Response("Bad Request", { status: 400 });
  }
  const bytes = Buffer.from(await request.arrayBuffer());
  await putObject(key, bytes, request.headers.get("content-type") ?? "application/octet-stream");
  return new Response(null, { status: 200 });
}
