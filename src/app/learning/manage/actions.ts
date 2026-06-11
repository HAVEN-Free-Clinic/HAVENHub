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

export async function uploadPackageAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  const file = formData.get("package");
  if (!(file instanceof File) || file.size === 0) {
    throw new LearningValidationError("Choose a .zip SCORM package to upload.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new LearningValidationError("That package is too large (max 75 MB).");
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  await ingestScormPackage(courseId, bytes, person.personId);
  revalidatePath(`/learning/manage/${courseId}`);
}
