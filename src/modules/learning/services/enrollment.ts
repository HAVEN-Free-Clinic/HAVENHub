import type { CourseModuleKind, Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { gradeQuiz, type GradedQuestion } from "@/platform/quiz/grading";
import { coursesForMember, type AssignableCourse } from "../engine/assignment";
import { isCourseComplete, progressCounts, type ModuleState } from "../engine/completion";
import { LearningAuthError, LearningValidationError } from "./errors";
import { parseQuizQuestions, type QuizQuestion } from "./types";

type Tx = Prisma.TransactionClient;

/** Active term used for assignment (mirrors compliance/training: newest ACTIVE term). */
async function activeTermId(): Promise<string | null> {
  const term = await prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } });
  return term?.id ?? null;
}

/** Department ids the person is an active volunteer of in the active term. */
async function memberDepartmentIds(personId: string, termId: string): Promise<string[]> {
  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId, status: "ACTIVE" },
    select: { departmentId: true },
  });
  return memberships.map((m) => m.departmentId);
}

/** Resolve the active-course ids assigned to this person right now. */
async function assignedCourseIds(personId: string): Promise<string[]> {
  const termId = await activeTermId();
  if (!termId) return [];
  const memberDepts = await memberDepartmentIds(personId, termId);
  const courses = await prisma.course.findMany({
    where: { isActive: true },
    select: { id: true, isActive: true, assignToAll: true, departments: { select: { departmentId: true } } },
  });
  const assignable: AssignableCourse[] = courses.map((c) => ({
    id: c.id,
    isActive: c.isActive,
    assignToAll: c.assignToAll,
    departmentIds: c.departments.map((d) => d.departmentId),
  }));
  return coursesForMember({ courses: assignable, memberDepartmentIds: memberDepts });
}

export type MyCourseRow = {
  id: string;
  title: string;
  description: string | null;
  done: number;
  total: number;
  status: "IN_PROGRESS" | "COMPLETE";
};

/** Learner-facing status is derived live from module states; CourseProgress is the persisted projection kept in sync by recomputeCourseProgress after every mutation. */
export async function getMyCourses(personId: string): Promise<MyCourseRow[]> {
  const ids = await assignedCourseIds(personId);
  if (ids.length === 0) return [];
  const courses = await prisma.course.findMany({
    where: { id: { in: ids } },
    orderBy: { position: "asc" },
    include: { modules: { select: { id: true, kind: true } } },
  });
  const moduleIds = courses.flatMap((c) => c.modules.map((m) => m.id));
  const progress = await prisma.moduleProgress.findMany({
    where: { personId, moduleId: { in: moduleIds } },
    select: { moduleId: true, completedAt: true },
  });
  const passed = await latestPassByModule(personId, moduleIds);
  const completeByModule = new Map(progress.map((p) => [p.moduleId, p.completedAt != null]));

  return courses.map((c) => {
    const states = c.modules.map<ModuleState>((m) => ({
      kind: m.kind,
      completed: completeByModule.get(m.id) ?? false,
      quizPassed: passed.has(m.id),
    }));
    const counts = progressCounts(states);
    return {
      id: c.id,
      title: c.title,
      description: c.description,
      done: counts.done,
      total: counts.total,
      status: isCourseComplete(states) ? "COMPLETE" : "IN_PROGRESS",
    };
  });
}

/** Module ids the person has at least one passing attempt on. */
async function latestPassByModule(personId: string, moduleIds: string[]): Promise<Set<string>> {
  if (moduleIds.length === 0) return new Set();
  const rows = await prisma.moduleProgress.findMany({
    where: { personId, moduleId: { in: moduleIds }, attempts: { some: { passed: true } } },
    select: { moduleId: true },
  });
  return new Set(rows.map((r) => r.moduleId));
}

export type LearnerModule = {
  id: string;
  title: string;
  kind: CourseModuleKind;
  description: string | null;
  url: string | null;
  questions: QuizQuestion[];
  completed: boolean;
  quizPassed: boolean;
  locked: boolean;
  attemptsUsed: number;
  maxAttempts: number;
  passPercent: number;
};

export type LearnerCourse = {
  id: string;
  title: string;
  description: string | null;
  status: "IN_PROGRESS" | "COMPLETE";
  modules: LearnerModule[];
};

async function quizDefaults(): Promise<{ passPercent: number; maxAttempts: number }> {
  const [passPercent, maxAttempts] = await Promise.all([
    getSetting<number>("learning.defaultQuizPassPercent"),
    getSetting<number>("learning.defaultQuizMaxAttempts"),
  ]);
  return { passPercent, maxAttempts };
}

export async function getCourseForLearner(personId: string, courseId: string): Promise<LearnerCourse> {
  const ids = await assignedCourseIds(personId);
  if (!ids.includes(courseId)) {
    throw new LearningAuthError("This course is not assigned to you.");
  }
  const course = await prisma.course.findUniqueOrThrow({
    where: { id: courseId },
    include: { modules: { orderBy: { position: "asc" } } },
  });
  const defaults = await quizDefaults();
  const moduleIds = course.modules.map((m) => m.id);
  const progressRows = await prisma.moduleProgress.findMany({
    where: { personId, moduleId: { in: moduleIds } },
    include: { attempts: { orderBy: { takenAt: "desc" } } },
  });
  const progressByModule = new Map(progressRows.map((p) => [p.moduleId, p]));

  const modules = course.modules.map<LearnerModule>((m) => {
    const p = progressByModule.get(m.id);
    const windowStart = p?.lockResetAt ?? null;
    const attemptsUsed = (p?.attempts ?? []).filter((a) => !windowStart || a.takenAt >= windowStart).length;
    const quizPassed = (p?.attempts ?? []).some((a) => a.passed);
    return {
      id: m.id,
      title: m.title,
      kind: m.kind,
      description: m.description,
      url: m.url,
      questions: parseQuizQuestions(m.questions),
      completed: p?.completedAt != null,
      quizPassed,
      locked: p?.locked ?? false,
      attemptsUsed,
      maxAttempts: m.maxAttempts ?? defaults.maxAttempts,
      passPercent: m.passPercent ?? defaults.passPercent,
    };
  });

  const states = modules.map<ModuleState>((m) => ({ kind: m.kind, completed: m.completed, quizPassed: m.quizPassed }));
  return {
    id: course.id,
    title: course.title,
    description: course.description,
    status: isCourseComplete(states) ? "COMPLETE" : "IN_PROGRESS",
    modules,
  };
}

/**
 * Recompute and persist CourseProgress for one person+course inside a tx.
 * CourseProgress is the persisted projection of learner-facing status; it must
 * always agree with the live module states after any mutation.  completedAt is
 * set exactly once (when the course first becomes COMPLETE) and is preserved on
 * subsequent recomputes; it is cleared only if the course reverts to IN_PROGRESS.
 */
async function recomputeCourseProgress(tx: Tx, personId: string, courseId: string): Promise<void> {
  const modules = await tx.courseModule.findMany({ where: { courseId }, select: { id: true, kind: true } });
  const moduleIds = modules.map((m) => m.id);
  const progress = await tx.moduleProgress.findMany({
    where: { personId, moduleId: { in: moduleIds } },
    select: { moduleId: true, completedAt: true, attempts: { where: { passed: true }, select: { id: true }, take: 1 } },
  });
  const byModule = new Map(progress.map((p) => [p.moduleId, p]));
  const states = modules.map<ModuleState>((m) => {
    const p = byModule.get(m.id);
    return { kind: m.kind, completed: p?.completedAt != null, quizPassed: (p?.attempts.length ?? 0) > 0 };
  });
  const complete = isCourseComplete(states);

  // Fetch the existing row so we can preserve completedAt once it is set.
  const existing = await tx.courseProgress.findUnique({
    where: { personId_courseId: { personId, courseId } },
    select: { completedAt: true },
  });

  // completedAt is set the first time the course becomes complete, preserved on
  // later recomputes, and cleared only when the course becomes incomplete again.
  const completedAt: Date | null = complete
    ? (existing?.completedAt ?? new Date())
    : null;

  await tx.courseProgress.upsert({
    where: { personId_courseId: { personId, courseId } },
    create: { personId, courseId, status: complete ? "COMPLETE" : "IN_PROGRESS", completedAt },
    update: { status: complete ? "COMPLETE" : "IN_PROGRESS", completedAt },
  });
}

export async function markModuleComplete(personId: string, moduleId: string): Promise<void> {
  const mod = await prisma.courseModule.findUniqueOrThrow({ where: { id: moduleId } });
  if (mod.kind === "QUIZ") {
    throw new LearningValidationError("Quiz modules are completed by passing the quiz.");
  }
  const ids = await assignedCourseIds(personId);
  if (!ids.includes(mod.courseId)) throw new LearningAuthError("This course is not assigned to you.");

  await prisma.$transaction(async (tx) => {
    await tx.moduleProgress.upsert({
      where: { personId_moduleId: { personId, moduleId } },
      create: { personId, moduleId, completedAt: new Date() },
      update: { completedAt: new Date() },
    });
    await recomputeCourseProgress(tx, personId, mod.courseId);
  });
}

export type CourseQuizResult = { score: number; total: number; percent: number; passed: boolean };

export async function submitCourseQuiz(
  personId: string,
  moduleId: string,
  answers: Record<string, unknown>
): Promise<CourseQuizResult> {
  const mod = await prisma.courseModule.findUniqueOrThrow({ where: { id: moduleId } });
  if (mod.kind !== "QUIZ") throw new LearningValidationError("This module is not a quiz.");
  const ids = await assignedCourseIds(personId);
  if (!ids.includes(mod.courseId)) throw new LearningAuthError("This course is not assigned to you.");

  const questions = parseQuizQuestions(mod.questions);
  if (questions.length === 0) throw new LearningValidationError("This quiz has no questions yet.");
  const graded: GradedQuestion[] = questions.map((q) => ({ key: q.key, correctValue: q.correctValue }));
  const defaults = await quizDefaults();
  const passPercent = mod.passPercent ?? defaults.passPercent;
  const maxAttempts = mod.maxAttempts ?? defaults.maxAttempts;

  return prisma.$transaction(async (tx) => {
    const mp = await tx.moduleProgress.upsert({
      where: { personId_moduleId: { personId, moduleId } },
      create: { personId, moduleId },
      update: {},
    });
    if (mp.locked) throw new LearningValidationError("This quiz is locked. Ask a manager to reset it.");
    const alreadyPassed = await tx.courseQuizAttempt.count({ where: { moduleProgressId: mp.id, passed: true } }) > 0;
    if (alreadyPassed) throw new LearningValidationError("You have already passed this quiz.");

    const result = gradeQuiz(graded, answers, passPercent);
    await tx.courseQuizAttempt.create({
      data: { moduleProgressId: mp.id, answers: answers as Prisma.InputJsonValue, score: result.score, total: result.total, passed: result.passed },
    });

    if (result.passed) {
      await tx.moduleProgress.update({ where: { id: mp.id }, data: { completedAt: new Date() } });
    } else {
      const windowAttempts = await tx.courseQuizAttempt.count({
        where: { moduleProgressId: mp.id, ...(mp.lockResetAt ? { takenAt: { gte: mp.lockResetAt } } : {}) },
      });
      if (windowAttempts >= maxAttempts) {
        await tx.moduleProgress.update({ where: { id: mp.id }, data: { locked: true } });
      }
    }
    await recomputeCourseProgress(tx, personId, mod.courseId);
    return { score: result.score, total: result.total, percent: result.percent, passed: result.passed };
  });
}
