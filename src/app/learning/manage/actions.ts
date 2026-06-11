"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { createCourse, updateCourse, setCourseAssignment } from "@/modules/learning/services/courses";
import { LearningValidationError } from "@/modules/learning/services/errors";

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

