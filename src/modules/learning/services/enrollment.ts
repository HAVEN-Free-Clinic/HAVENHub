import { prisma } from "@/platform/db";
import { coursesForMember, type AssignableCourse } from "../engine/assignment";
import { deriveStatus, rollupStatus } from "../engine/status";
import type { ScoEntry } from "../engine/manifest";
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

/**
 * The course's SCO list. Uses the stored manifest list (keeping only well-formed
 * entries); for a legacy package (scormScos null) synthesizes a single SCO
 * ("sco-0") from scormEntryHref so old courses keep working without re-ingest.
 */
function courseScos(course: { scormScos: unknown; scormEntryHref: string | null; title: string }): ScoEntry[] {
  if (Array.isArray(course.scormScos)) {
    return course.scormScos.filter(
      (s): s is ScoEntry =>
        !!s &&
        typeof s === "object" &&
        typeof (s as ScoEntry).id === "string" &&
        typeof (s as ScoEntry).title === "string" &&
        typeof (s as ScoEntry).href === "string"
    );
  }
  if (course.scormEntryHref) return [{ id: "sco-0", title: course.title, href: course.scormEntryHref }];
  return [];
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

export type LearnerSco = {
  id: string;
  title: string;
  href: string;
  cmi: CmiSnapshot;
};

export type LearnerCourse = {
  id: string;
  title: string;
  description: string | null;
  status: LearnerStatus;
  scos: LearnerSco[];
};

export async function getCourseForLearner(personId: string, courseId: string): Promise<LearnerCourse> {
  if (!(await isCourseAssignedTo(personId, courseId))) {
    throw new LearningAuthError("This course is not assigned to you.");
  }
  const course = await prisma.course.findUniqueOrThrow({
    where: { id: courseId },
    select: { id: true, title: true, description: true, scormScos: true, scormEntryHref: true },
  });
  const scos = courseScos(course);

  const scoRows = await prisma.scoProgress.findMany({ where: { personId, courseId } });
  const byId = new Map(scoRows.map((r) => [r.scoId, r]));

  const rollup = await prisma.courseProgress.findUnique({
    where: { personId_courseId: { personId, courseId } },
    select: { status: true },
  });
  const status: LearnerStatus = !rollup ? "NOT_STARTED" : (rollup.status as LearnerStatus);

  return {
    id: course.id,
    title: course.title,
    description: course.description,
    status,
    scos: scos.map((s) => {
      const r = byId.get(s.id);
      return {
        id: s.id,
        title: s.title,
        href: s.href,
        cmi: {
          lessonStatus: r?.lessonStatus ?? null,
          scoreRaw: r?.scoreRaw ?? null,
          suspendData: r?.suspendData ?? null,
          lessonLocation: r?.lessonLocation ?? null,
        },
      };
    }),
  };
}

export type CmiSnapshot = {
  lessonStatus: string | null;
  scoreRaw: number | null;
  suspendData: string | null;
  lessonLocation: string | null;
};

/**
 * Persist one SCO's CMI snapshot, then recompute the course rollup. Idempotent:
 * re-commits update state; per-SCO and course completedAt are each stamped once
 * (the first time that level becomes COMPLETE) and preserved afterwards.
 *
 * CourseProgress remains the course-level rollup record (its status/lessonStatus/
 * completedAt drive the dashboard and "My Courses"); per-SCO state lives in
 * ScoProgress.
 */
export async function persistScoCmi(
  personId: string,
  courseId: string,
  scoId: string,
  cmi: CmiSnapshot
): Promise<void> {
  if (!(await isCourseAssignedTo(personId, courseId))) {
    throw new LearningAuthError("This course is not assigned to you.");
  }

  // 1. Upsert this SCO's state.
  const sco = deriveStatus(cmi.lessonStatus);
  const existingSco = await prisma.scoProgress.findUnique({
    where: { personId_courseId_scoId: { personId, courseId, scoId } },
    select: { completedAt: true },
  });
  const scoCompletedAt = sco.completed ? (existingSco?.completedAt ?? new Date()) : null;
  const scoData = {
    completedAt: scoCompletedAt,
    lessonStatus: cmi.lessonStatus,
    scoreRaw: cmi.scoreRaw == null ? null : Math.round(cmi.scoreRaw),
    suspendData: cmi.suspendData,
    lessonLocation: cmi.lessonLocation,
  };
  await prisma.scoProgress.upsert({
    where: { personId_courseId_scoId: { personId, courseId, scoId } },
    create: { personId, courseId, scoId, ...scoData },
    update: scoData,
  });

  // 2. Recompute the course rollup over every SCO in the manifest.
  const course = await prisma.course.findUniqueOrThrow({
    where: { id: courseId },
    select: { scormScos: true, scormEntryHref: true, title: true },
  });
  const scos = courseScos(course);
  const rows = await prisma.scoProgress.findMany({
    where: { personId, courseId },
    select: { scoId: true, lessonStatus: true },
  });
  const statusById = new Map(rows.map((r) => [r.scoId, r.lessonStatus]));
  const roll = rollupStatus(scos.map((s) => statusById.get(s.id) ?? null));

  const existingCourse = await prisma.courseProgress.findUnique({
    where: { personId_courseId: { personId, courseId } },
    select: { completedAt: true },
  });
  const completedAt = roll.completed ? (existingCourse?.completedAt ?? new Date()) : null;

  // lessonStatus is a rollup token so existing readers (dashboard, getMyCourses)
  // keep deriving the course status from CourseProgress unchanged.
  const courseData = {
    status: roll.status,
    completedAt,
    lessonStatus: roll.completed ? "completed" : "incomplete",
    scoreRaw: null,
    suspendData: null,
    lessonLocation: null,
  };
  await prisma.courseProgress.upsert({
    where: { personId_courseId: { personId, courseId } },
    create: { personId, courseId, ...courseData },
    update: courseData,
  });
}
