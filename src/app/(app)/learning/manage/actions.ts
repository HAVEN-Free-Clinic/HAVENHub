"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { CourseAudience } from "@prisma/client";
import { requirePermission } from "@/platform/auth/session";
import { createCourse, updateCourse, setCourseAssignment } from "@/modules/learning/services/courses";
import { ingestScormPackage } from "@/modules/learning/services/packages";
import { LearningValidationError } from "@/modules/learning/services/errors";
import { getObject, deleteObject } from "@/platform/storage";

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
  const raw = String(formData.get("audience") ?? "EVERYONE");
  const audience: CourseAudience = raw === "DIRECTORS" || raw === "VOLUNTEERS" ? raw : "EVERYONE";
  await setCourseAssignment(courseId, { departmentIds, assignToAll: formData.get("assignToAll") === "on", audience }, person.personId);
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
  const resetProgress = formData.get("resetProgress") === "on";
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    await ingestScormPackage(courseId, bytes, person.personId, { resetProgress });
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
 * Validate that a client-supplied blob pathname stays within this course's own
 * upload prefix. The browser controls this string, so we never read or delete a
 * pathname outside scorm-uploads/<courseId>/ (prevents reading/deleting other
 * tenants' blobs). Returns the safe pathname.
 */
function safeUploadPathname(pathname: string, courseId: string): string {
  const norm = pathname.replace(/^\/+/, "");
  if (!norm.startsWith(`scorm-uploads/${courseId}/`) || norm.split("/").some((s) => s === "..")) {
    throw new LearningValidationError("Invalid upload reference.");
  }
  return norm;
}

/**
 * Ingest a SCORM package the browser already uploaded directly to Blob (the path
 * used on Vercel, where the function request body is capped at 4.5 MB). The blob
 * is PRIVATE; we read its bytes through the storage abstraction by pathname (no
 * fetch of a client URL), ingest, then delete the transient upload.
 */
export async function ingestUploadedPackageAction(input: {
  courseId: string;
  pathname: string;
  resetProgress?: boolean;
}): Promise<UploadState> {
  const person = await requirePermission("learning.manage_courses");

  let key: string;
  try {
    key = safeUploadPathname(input.pathname, input.courseId);
  } catch (err) {
    if (err instanceof LearningValidationError) return { error: err.message };
    throw err;
  }

  try {
    const bytes = await getObject(key);
    if (!bytes) return { error: "Could not read the uploaded package from storage." };
    await ingestScormPackage(input.courseId, bytes, person.personId, { resetProgress: !!input.resetProgress });
  } catch (err) {
    if (err instanceof LearningValidationError) return { error: err.message };
    throw err;
  } finally {
    // Best-effort cleanup of the transient upload (validated key only).
    await deleteObject(key).catch(() => undefined);
  }
  revalidatePath(`/learning/manage/${input.courseId}`);
  return null;
}
