import type { Course, CourseModule, CourseModuleKind } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { LearningAuthError, LearningValidationError } from "./errors";
import { parseQuizQuestions, type QuizQuestion } from "./types";

async function requireManager(actorId: string): Promise<void> {
  if (!(await can(actorId, "learning.manage_courses"))) {
    throw new LearningAuthError("You do not have permission to manage courses.");
  }
}

export type CourseInput = {
  title: string;
  description?: string | null;
  isActive?: boolean;
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
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.course_update",
    entityType: "Course",
    entityId: id,
    after: { title, isActive: course.isActive },
  });
  return course;
}

export async function setCourseAssignment(
  courseId: string,
  input: { departmentIds: string[]; assignToAll: boolean },
  actorId: string
): Promise<void> {
  await requireManager(actorId);
  await prisma.$transaction(async (tx) => {
    await tx.course.update({ where: { id: courseId }, data: { assignToAll: input.assignToAll } });
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

export type ModuleInput = {
  title: string;
  kind: CourseModuleKind;
  description?: string | null;
  url?: string | null;
  questions?: QuizQuestion[];
  passPercent?: number | null;
  maxAttempts?: number | null;
};

function validateModule(input: ModuleInput): void {
  if (!input.title.trim()) throw new LearningValidationError("Module title is required.");
  if (input.kind === "VIDEO" || input.kind === "DOCUMENT") {
    if (!input.url || !input.url.trim()) {
      throw new LearningValidationError("A video or document module needs a link.");
    }
  }
  if (input.kind === "QUIZ") {
    const qs = input.questions ?? [];
    if (qs.length === 0) throw new LearningValidationError("A quiz module needs at least one question.");
    if (input.passPercent != null) {
      if (!Number.isInteger(input.passPercent)) {
        throw new LearningValidationError("Pass percent must be a whole number.");
      }
      if (input.passPercent < 0 || input.passPercent > 100) {
        throw new LearningValidationError("Pass percent must be between 0 and 100.");
      }
    }
    if (input.maxAttempts != null) {
      if (!Number.isInteger(input.maxAttempts)) {
        throw new LearningValidationError("Max attempts must be a whole number.");
      }
      if (input.maxAttempts < 1) {
        throw new LearningValidationError("Max attempts must be at least 1.");
      }
    }
  }
}

/** Shared content fields for both create and update paths. */
function buildModuleFields(input: ModuleInput) {
  const isQuiz = input.kind === "QUIZ";
  return {
    title: input.title.trim(),
    kind: input.kind,
    description: input.description?.trim() || null,
    url: isQuiz ? null : (input.url?.trim() ?? null),
    questions: isQuiz ? (input.questions as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
    passPercent: isQuiz ? (input.passPercent ?? null) : null,
    maxAttempts: isQuiz ? (input.maxAttempts ?? null) : null,
  };
}

function buildModuleCreateData(
  courseId: string,
  position: number,
  input: ModuleInput
): Prisma.CourseModuleUncheckedCreateInput {
  return { courseId, position, ...buildModuleFields(input) };
}

function buildModuleUpdateData(input: ModuleInput): Prisma.CourseModuleUpdateInput {
  return buildModuleFields(input);
}

export async function addModule(courseId: string, input: ModuleInput, actorId: string): Promise<CourseModule> {
  await requireManager(actorId);
  validateModule(input);
  const created = await prisma.$transaction(async (tx) => {
    const max = await tx.courseModule.aggregate({ where: { courseId }, _max: { position: true } });
    const position = (max._max.position ?? -1) + 1;
    return tx.courseModule.create({
      data: buildModuleCreateData(courseId, position, input),
    });
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.module_create",
    entityType: "CourseModule",
    entityId: created.id,
    after: { courseId, title: created.title, kind: created.kind },
  });
  return created;
}

export async function updateModule(id: string, input: ModuleInput, actorId: string): Promise<CourseModule> {
  await requireManager(actorId);
  validateModule(input);
  const existing = await prisma.courseModule.findUnique({ where: { id } });
  if (!existing) throw new LearningValidationError("Module not found.");
  const updated = await prisma.courseModule.update({
    where: { id },
    data: buildModuleUpdateData(input),
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.module_update",
    entityType: "CourseModule",
    entityId: id,
    after: { title: updated.title, kind: updated.kind },
  });
  return updated;
}

export async function deleteModule(id: string, actorId: string): Promise<void> {
  await requireManager(actorId);
  const existing = await prisma.courseModule.findUnique({ where: { id } });
  if (!existing) throw new LearningValidationError("Module not found.");
  await prisma.courseModule.delete({ where: { id } });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.module_delete",
    entityType: "CourseModule",
    entityId: id,
  });
}

/** Persist a new module order. Writes positions in two passes to dodge the
 *  @@unique([courseId, position]) constraint during the shuffle. First pass uses
 *  negative temporaries (-(i+1)), which can never collide with real non-negative
 *  positions. Second pass writes the final 0-based positions. */
export async function reorderModules(courseId: string, orderedIds: string[], actorId: string): Promise<void> {
  await requireManager(actorId);
  await prisma.$transaction(async (tx) => {
    const existing = await tx.courseModule.findMany({
      where: { id: { in: orderedIds }, courseId },
      select: { id: true },
    });
    if (existing.length !== orderedIds.length) {
      throw new LearningValidationError("Reorder list does not match this course's modules.");
    }
    for (let i = 0; i < orderedIds.length; i++) {
      await tx.courseModule.update({ where: { id: orderedIds[i] }, data: { position: -(i + 1) } });
    }
    for (let i = 0; i < orderedIds.length; i++) {
      await tx.courseModule.update({ where: { id: orderedIds[i] }, data: { position: i } });
    }
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.module_reorder",
    entityType: "Course",
    entityId: courseId,
  });
}

export type CourseListRow = {
  id: string;
  title: string;
  isActive: boolean;
  moduleCount: number;
  assignToAll: boolean;
};

export async function listCourses(): Promise<CourseListRow[]> {
  const courses = await prisma.course.findMany({
    orderBy: { position: "asc" },
    include: { _count: { select: { modules: true } } },
  });
  return courses.map((c) => ({
    id: c.id,
    title: c.title,
    isActive: c.isActive,
    assignToAll: c.assignToAll,
    moduleCount: c._count.modules,
  }));
}

export async function getCourseForEdit(id: string) {
  const course = await prisma.course.findUnique({
    where: { id },
    include: { modules: { orderBy: { position: "asc" } }, departments: true },
  });
  if (!course) return null;
  return {
    ...course,
    modules: course.modules.map((m) => ({ ...m, questions: parseQuizQuestions(m.questions) })),
  };
}
