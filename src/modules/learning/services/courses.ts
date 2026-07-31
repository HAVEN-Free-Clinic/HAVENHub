import type { Course, CourseAudience, CourseRecurrence } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { LearningAuthError, LearningValidationError } from "./errors";

async function requireManager(actorId: string): Promise<void> {
  if (!(await can(actorId, "learning.manage_courses"))) {
    throw new LearningAuthError("You do not have permission to manage courses.");
  }
}

export type CourseInput = {
  title: string;
  description?: string | null;
  isActive?: boolean;
  /** Omitted leaves the existing value alone, same convention as isActive below. */
  recurrence?: CourseRecurrence;
};

export async function createCourse(input: CourseInput, actorId: string): Promise<Course> {
  await requireManager(actorId);
  const title = input.title.trim();
  if (!title) throw new LearningValidationError("Course title is required.");
  const max = await prisma.course.aggregate({ _max: { position: true } });
  const course = await prisma.course.create({
    data: {
      title,
      description: input.description?.trim() || null,
      isActive: input.isActive ?? true,
      position: (max._max.position ?? -1) + 1,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.course_create",
    entityType: "Course",
    entityId: course.id,
    after: { title },
  });
  return course;
}

export async function updateCourse(id: string, input: CourseInput, actorId: string): Promise<Course> {
  await requireManager(actorId);
  const title = input.title.trim();
  if (!title) throw new LearningValidationError("Course title is required.");
  const existing = await prisma.course.findUnique({ where: { id } });
  if (!existing) throw new LearningValidationError("Course not found.");
  const course = await prisma.course.update({
    where: { id },
    data: {
      title,
      description: input.description?.trim() || null,
      isActive: input.isActive ?? undefined,
      recurrence: input.recurrence ?? undefined,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.course_update",
    entityType: "Course",
    entityId: id,
    after: { title, isActive: course.isActive, recurrence: course.recurrence },
  });
  return course;
}

export async function setCourseAssignment(
  courseId: string,
  input: { departmentIds: string[]; assignToAll: boolean; audience: CourseAudience },
  actorId: string
): Promise<void> {
  await requireManager(actorId);
  await prisma.$transaction(async (tx) => {
    await tx.course.update({ where: { id: courseId }, data: { assignToAll: input.assignToAll, audience: input.audience } });
    await tx.courseDepartment.deleteMany({ where: { courseId } });
    if (input.departmentIds.length > 0) {
      await tx.courseDepartment.createMany({
        data: input.departmentIds.map((departmentId) => ({ courseId, departmentId })),
        skipDuplicates: true,
      });
    }
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.course_assign",
    entityType: "Course",
    entityId: courseId,
    after: input as unknown as Prisma.InputJsonValue,
  });
}

export type CourseListRow = {
  id: string;
  title: string;
  isActive: boolean;
  assignToAll: boolean;
  hasPackage: boolean;
};

export async function listCourses(): Promise<CourseListRow[]> {
  const courses = await prisma.course.findMany({ orderBy: { position: "asc" } });
  return courses.map((c) => ({
    id: c.id,
    title: c.title,
    isActive: c.isActive,
    assignToAll: c.assignToAll,
    hasPackage: c.scormEntryHref != null,
  }));
}

export async function getCourseForEdit(id: string) {
  return prisma.course.findUnique({ where: { id }, include: { departments: true } });
}

/**
 * Recurrence per course id, for annotating a learner-facing course list with
 * "Retake each term" without touching enrollment.ts's assignment/progress reads.
 */
export async function getCourseRecurrenceById(courseIds: string[]): Promise<Record<string, CourseRecurrence>> {
  if (courseIds.length === 0) return {};
  const rows = await prisma.course.findMany({
    where: { id: { in: courseIds } },
    select: { id: true, recurrence: true },
  });
  return Object.fromEntries(rows.map((r) => [r.id, r.recurrence]));
}
