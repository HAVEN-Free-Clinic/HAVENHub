"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { CourseAudience, CourseRecurrence } from "@prisma/client";
import { requirePermission } from "@/platform/auth/session";
import { createCourse, updateCourse, setCourseAssignment } from "@/modules/learning/services/courses";
import { ingestScormPackage } from "@/modules/learning/services/packages";
import { LearningValidationError } from "@/modules/learning/services/errors";
import { runAction } from "@/platform/actions";
import { getObject, deleteObject } from "@/platform/storage";

/** Upper bound on the COMPRESSED upload size. Bounds the memory a malicious or
 *  accidental over-large zip can consume before the uncompressed-size check in
 *  ingestScormPackage runs. Real eXeLearning SCORM packages are well under this. */
const MAX_UPLOAD_BYTES = 75 * 1024 * 1024; // 75 MB

export async function createCourseAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  // A whitespace-only title passes the input's HTML `required` but fails the
  // server-side trim in createCourse; surface that as an inline message instead of
  // letting the thrown LearningValidationError hit the generic error boundary (#85).
  let course;
  try {
    course = await createCourse(
      { title: String(formData.get("title") ?? ""), description: String(formData.get("description") ?? "") },
      person.personId
    );
  } catch (err) {
    if (err instanceof LearningValidationError) {
      redirect(`/learning/manage?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  redirect(`/learning/manage/${course.id}`);
}

export async function updateCourseAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const id = String(formData.get("courseId"));
  const rawRecurrence = String(formData.get("recurrence") ?? "ONCE");
  const recurrence: CourseRecurrence = rawRecurrence === "PER_TERM" ? "PER_TERM" : "ONCE";
  // A blank/whitespace title throws LearningValidationError from updateCourse. Route
  // it back to the edit page as ?error= (inline Alert) rather than crashing the page
  // to the (app) error boundary, which discarded the manager's other edits (#85).
  await runAction({
    work: () =>
      updateCourse(
        id,
        {
          title: String(formData.get("title") ?? ""),
          description: String(formData.get("description") ?? ""),
          isActive: formData.get("isActive") === "on",
          recurrence,
        },
        person.personId
      ),
    domainErrors: [LearningValidationError],
    errorRedirect: (m) => `/learning/manage/${id}?error=${encodeURIComponent(m)}`,
    revalidate: `/learning/manage/${id}`,
  });
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

/** Reject an upload key that does not belong to this course's staging namespace. */
function safeUploadKey(key: string, courseId: string): string {
  const norm = key.replace(/^\/+/, "");
  if (!norm.startsWith(`scorm-uploads/${courseId}/`) || norm.split("/").some((s) => s === "..")) {
    throw new LearningValidationError("Invalid upload reference.");
  }
  return norm;
}

/**
 * Ingest a SCORM package the browser already uploaded directly to R2 (the path
 * used on Vercel, where the function request body is capped at 4.5 MB). We read
 * the object's bytes through the storage abstraction by key (no fetch of a
 * client URL), ingest, then delete the transient upload.
 */
export async function ingestUploadedPackageAction(input: {
  courseId: string;
  key: string;
  resetProgress?: boolean;
}): Promise<UploadState> {
  const person = await requirePermission("learning.manage_courses");

  let key: string;
  try {
    key = safeUploadKey(input.key, input.courseId);
  } catch (err) {
    if (err instanceof LearningValidationError) return { error: err.message };
    throw err;
  }

  try {
    const bytes = await getObject(key);
    if (!bytes) return { error: "Could not read the uploaded package from storage." };
    // The presigned URL capped nothing: it was signed against a size the client
    // declared, not the bytes it actually sent. This is the first look at the
    // real object, so check it before handing anything to the unzipper.
    if (bytes.length > MAX_UPLOAD_BYTES) {
      return { error: "That package is too large (max 75 MB)." };
    }
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
