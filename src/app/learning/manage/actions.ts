"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { createCourse, updateCourse, setCourseAssignment, addModule } from "@/modules/learning/services/courses";
import { LearningValidationError } from "@/modules/learning/services/errors";
import type { QuizQuestion } from "@/modules/learning/services/types";
import type { CourseModuleKind } from "@prisma/client";

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

export async function addModuleAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  const kind = String(formData.get("kind")) as CourseModuleKind;
  let questions: QuizQuestion[] | undefined;
  if (kind === "QUIZ") {
    try {
      questions = JSON.parse(String(formData.get("questions") ?? "[]")) as QuizQuestion[];
    } catch {
      throw new LearningValidationError("Questions must be valid JSON.");
    }
  }
  await addModule(
    courseId,
    {
      title: String(formData.get("title") ?? ""),
      kind,
      description: String(formData.get("description") ?? ""),
      url: String(formData.get("url") ?? ""),
      questions,
      passPercent: formData.get("passPercent") ? Number(formData.get("passPercent")) : null,
      maxAttempts: formData.get("maxAttempts") ? Number(formData.get("maxAttempts")) : null,
    },
    person.personId
  );
  revalidatePath(`/learning/manage/${courseId}`);
}
