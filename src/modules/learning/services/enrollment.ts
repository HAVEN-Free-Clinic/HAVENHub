import { prisma } from "@/platform/db";
import { coursesForMember, type AssignableCourse } from "../engine/assignment";
import { deriveStatus } from "../engine/status";
import { LearningAuthError } from "./errors";

/** Active term used for assignment (newest ACTIVE term). */
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

/** True when the course is currently assigned to this person (for the play route). */
export async function isCourseAssignedTo(personId: string, courseId: string): Promise<boolean> {
  const ids = await assignedCourseIds(personId);
  return ids.includes(courseId);
}

export type LearnerStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE";

export type MyCourseRow = {
  id: string;
  title: string;
  description: string | null;
  status: LearnerStatus;
};

export async function getMyCourses(personId: string): Promise<MyCourseRow[]> {
  const ids = await assignedCourseIds(personId);
  if (ids.length === 0) return [];
  const courses = await prisma.course.findMany({
    where: { id: { in: ids } },
    orderBy: { position: "asc" },
    select: { id: true, title: true, description: true },
  });
  const progress = await prisma.courseProgress.findMany({
    where: { personId, courseId: { in: ids } },
    select: { courseId: true, lessonStatus: true },
  });
  const byCourse = new Map(progress.map((p) => [p.courseId, p]));
  return courses.map((c) => {
    const p = byCourse.get(c.id);
    const status: LearnerStatus = !p
      ? "NOT_STARTED"
      : deriveStatus(p.lessonStatus).status;
    return { id: c.id, title: c.title, description: c.description, status };
  });
}

export type LearnerCourse = {
  id: string;
  title: string;
  description: string | null;
  entryHref: string | null;
  status: LearnerStatus;
  cmi: {
    lessonStatus: string | null;
    scoreRaw: number | null;
    suspendData: string | null;
    lessonLocation: string | null;
  };
};

export async function getCourseForLearner(personId: string, courseId: string): Promise<LearnerCourse> {
  if (!(await isCourseAssignedTo(personId, courseId))) {
    throw new LearningAuthError("This course is not assigned to you.");
  }
  const course = await prisma.course.findUniqueOrThrow({ where: { id: courseId } });
  const progress = await prisma.courseProgress.findUnique({
    where: { personId_courseId: { personId, courseId } },
  });
  const status: LearnerStatus = !progress ? "NOT_STARTED" : deriveStatus(progress.lessonStatus).status;
  return {
    id: course.id,
    title: course.title,
    description: course.description,
    entryHref: course.scormEntryHref,
    status,
    cmi: {
      lessonStatus: progress?.lessonStatus ?? null,
      scoreRaw: progress?.scoreRaw ?? null,
      suspendData: progress?.suspendData ?? null,
      lessonLocation: progress?.lessonLocation ?? null,
    },
  };
}

export type CmiSnapshot = {
  lessonStatus: string | null;
  scoreRaw: number | null;
  suspendData: string | null;
  lessonLocation: string | null;
};

/**
 * Persist a SCORM CMI snapshot for one person+course. Idempotent: re-commits
 * update the state; completedAt is stamped once (the first time status becomes
 * COMPLETE) and preserved on later commits.
 */
export async function persistCmi(personId: string, courseId: string, cmi: CmiSnapshot): Promise<void> {
  if (!(await isCourseAssignedTo(personId, courseId))) {
    throw new LearningAuthError("This course is not assigned to you.");
  }
  const { status, completed } = deriveStatus(cmi.lessonStatus);
  const existing = await prisma.courseProgress.findUnique({
    where: { personId_courseId: { personId, courseId } },
    select: { completedAt: true },
  });
  const completedAt = completed ? (existing?.completedAt ?? new Date()) : null;

  const data = {
    status,
    completedAt,
    lessonStatus: cmi.lessonStatus,
    scoreRaw: cmi.scoreRaw,
    suspendData: cmi.suspendData,
    lessonLocation: cmi.lessonLocation,
  };
  await prisma.courseProgress.upsert({
    where: { personId_courseId: { personId, courseId } },
    create: { personId, courseId, ...data },
    update: data,
  });
}
