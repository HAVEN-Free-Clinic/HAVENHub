"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { createCourse, updateCourse, setCourseAssignment } from "@/modules/learning/services/courses";
import { ingestScormPackage } from "@/modules/learning/services/packages";
import { LearningValidationError } from "@/modules/learning/services/errors";

/** Upper bound on the COMPRESSED upload size. Bounds the memory a malicious or
 *  accidental over-large zip can consume before the uncompressed-size check in
 *  ingestScormPackage runs. Real eXeLearning SCORM packages are well under this. */
const MAX_UPLOAD_BYTES = 75 * 1024 * 1024; // 75 MB

export async function createCourseAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const course = await createCourse(
    { title: String(formData.get("title") ?? ""), description: String(formData.get("description") ?? "") },
    person.personId
  );
  redirect(`/learning/manage/${course.id}`);
}

export async function updateCourseAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const id = String(formData.get("courseId"));
  await updateCourse(
    id,
    {
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? ""),
      isActive: formData.get("isActive") === "on",
    },
    person.personId
  );
  revalidatePath(`/learning/manage/${id}`);
}

export async function setAssignmentAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  const departmentIds = formData.getAll("departmentIds").map(String);
  await setCourseAssignment(courseId, { departmentIds, assignToAll: formData.get("assignToAll") === "on" }, person.personId);
  revalidatePath(`/learning/manage/${courseId}`);
}

/** useActionState result: an error message to show inline, or null on success. */
export type UploadState = { error: string } | null;

export async function uploadPackageAction(_prev: UploadState, formData: FormData): Promise<UploadState> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  const file = formData.get("package");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a .zip SCORM package to upload." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: "That package is too large (max 75 MB)." };
  }
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    await ingestScormPackage(courseId, bytes, person.personId);
  } catch (err) {
    // Surface authoring mistakes (bad zip, no manifest, no launchable resource)
    // to the manager. Thrown Server Action errors are redacted in production, so
    // we return the message instead.
    if (err instanceof LearningValidationError) return { error: err.message };
    throw err;
  }
  revalidatePath(`/learning/manage/${courseId}`);
  return null;
}

/**
 * Validate that a client-supplied blob URL really points at our Vercel Blob store
 * and at this course's own upload prefix, then rebuild it from the checked parts.
 * Without this, fetching the raw client value is a server-side request forgery
 * vector (an attacker could aim the fetch at internal/metadata endpoints).
 */
function safeBlobUrl(rawUrl: string, courseId: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new LearningValidationError("Invalid upload reference.");
  }
  const hostOk = u.protocol === "https:" && /(^|\.)blob\.vercel-storage\.com$/.test(u.hostname);
  const pathOk = u.pathname.startsWith(`/scorm-uploads/${courseId}/`) && !u.pathname.includes("..");
  if (!hostOk || !pathOk) {
    throw new LearningValidationError("Invalid upload reference.");
  }
  // Reconstruct from validated host + path so no unexpected pieces reach fetch().
  return `https://${u.hostname}${u.pathname}`;
}

/**
 * Ingest a SCORM package that the browser already uploaded directly to Blob
 * (the path used on Vercel, where the function request body is capped at 4.5 MB).
 * Fetches the zip bytes from the blob URL, ingests, then deletes the temp upload.
 */
export async function ingestUploadedPackageAction(input: {
  courseId: string;
  url: string;
}): Promise<UploadState> {
  const person = await requirePermission("learning.manage_courses");

  let url: string;
  try {
    url = safeBlobUrl(input.url, input.courseId);
  } catch (err) {
    if (err instanceof LearningValidationError) return { error: err.message };
    throw err;
  }

  try {
    const res = await fetch(url);
    if (!res.ok) return { error: "Could not read the uploaded package from storage." };
    const bytes = Buffer.from(await res.arrayBuffer());
    await ingestScormPackage(input.courseId, bytes, person.personId);
  } catch (err) {
    if (err instanceof LearningValidationError) return { error: err.message };
    throw err;
  } finally {
    // Best-effort cleanup of the transient upload (validated URL only).
    try {
      const { del } = await import("@vercel/blob");
      await del(url, { token: process.env.BLOB_READ_WRITE_TOKEN });
    } catch {
      // already gone / not on Blob -- nothing to clean up
    }
  }
  revalidatePath(`/learning/manage/${input.courseId}`);
  return null;
}
