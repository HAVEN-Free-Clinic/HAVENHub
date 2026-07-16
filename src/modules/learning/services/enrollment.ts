import { prisma, runSerializable } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { coursesForMember, type AssignableCourse, type MemberMembership } from "../engine/assignment";
import { deriveStatus, rollupStatus } from "../engine/status";
import type { ScoEntry } from "../engine/manifest";
import { LearningAuthError, LearningValidationError } from "./errors";

/** Active term used for assignment (newest ACTIVE term). */
async function activeTermId(): Promise<string | null> {
  const term = await getActiveTerm();
  return term?.id ?? null;
}

/** The member's active memberships in the active term: department + kind. */
async function memberMemberships(personId: string, termId: string): Promise<MemberMembership[]> {
  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId, status: "ACTIVE" },
    select: { departmentId: true, kind: true },
  });
  return memberships.map((m) => ({ departmentId: m.departmentId, kind: m.kind }));
}

/** Resolve the active-course ids assigned to this person right now. */
async function assignedCourseIds(personId: string): Promise<string[]> {
  const termId = await activeTermId();
  if (!termId) return [];
  const memberships = await memberMemberships(personId, termId);
  const courses = await prisma.course.findMany({
    where: { isActive: true },
    select: { id: true, isActive: true, assignToAll: true, audience: true, scormEntryHref: true, departments: { select: { departmentId: true } } },
  });
  const assignable: AssignableCourse[] = courses.map((c) => ({
    id: c.id,
    isActive: c.isActive,
    assignToAll: c.assignToAll,
    departmentIds: c.departments.map((d) => d.departmentId),
    hasPackage: c.scormEntryHref != null,
    audience: c.audience,
  }));
  return coursesForMember({ courses: assignable, memberships });
}

/**
 * True when the course is currently assigned to this person (for the play route).
 *
 * Targeted equivalent of `assignedCourseIds(personId).includes(courseId)`: it loads
 * only this one course instead of every active course, then runs the exact same pure
 * `coursesForMember` resolver over it. `coursesForMember` evaluates each course
 * independently and only ever emits a course's own id, so restricting its input to
 * this single course yields the identical isActive/hasPackage/scope/kind decision for
 * this courseId. Same authorization guarantee, far cheaper on the per-file SCORM asset
 * route (one indexed lookup + the memberships query, not a full course scan per request).
 */
export async function isCourseAssignedTo(personId: string, courseId: string): Promise<boolean> {
  const termId = await activeTermId();
  if (!termId) return false;
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { id: true, isActive: true, assignToAll: true, audience: true, scormEntryHref: true, departments: { select: { departmentId: true } } },
  });
  if (!course) return false;
  const memberships = await memberMemberships(personId, termId);
  const assignable: AssignableCourse = {
    id: course.id,
    isActive: course.isActive,
    assignToAll: course.assignToAll,
    departmentIds: course.departments.map((d) => d.departmentId),
    hasPackage: course.scormEntryHref != null,
    audience: course.audience,
  };
  return coursesForMember({ courses: [assignable], memberships }).includes(courseId);
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
 * Normalize a client-supplied SCORM score before it reaches the int4 score
 * columns. persistScoCmi is guarded only by `learning.access`, so `cmi.scoreRaw`
 * is untrusted: a non-finite value (NaN/Infinity) or one outside int4 range would
 * throw a numeric-overflow at the upsert. SCORM scores are 0-100, so drop
 * non-finite values to null and clamp the rounded result to that safe range.
 */
function sanitizeScore(raw: number | null): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/**
 * Upper bounds on the untrusted TEXT fields of a persisted CMI snapshot. Like
 * cmi.scoreRaw, suspendData/lessonLocation/lessonStatus arrive from the client and
 * land in unbounded TEXT columns, so without a bound an assigned learner could loop
 * persistScoCmi with megabyte payloads (storage bloat). The caps sit well above real
 * SCORM traffic: SCORM 1.2 formally limits suspend_data to 4096 and lesson_location
 * to 255 chars, and lesson_status is a short fixed vocabulary token; these use the
 * more generous SCORM 2004 ceilings (64000 / 1000) plus headroom so no legitimate
 * package is ever affected. We truncate rather than reject so a genuine (merely large)
 * commit still saves its status/score instead of the client's fire-and-forget save
 * silently dropping everything.
 */
const MAX_SUSPEND_DATA = 64000;
const MAX_LESSON_LOCATION = 1000;
const MAX_LESSON_STATUS = 100;

/** Truncate an untrusted client string to a bound, leaving null and short values as-is. */
function capText(value: string | null, max: number): string | null {
  if (value == null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

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

  // Load the course's manifest once: it both validates the incoming scoId and drives
  // the rollup in step 2 (no second query).
  const course = await prisma.course.findUniqueOrThrow({
    where: { id: courseId },
    select: { scormScos: true, scormEntryHref: true, title: true },
  });
  const scos = courseScos(course);

  // Reject a scoId that is not one of the course's manifest SCOs, mirroring how
  // sanitizeScore guards scoreRaw. persistScoCmi is gated only by learning.access and
  // the unique key is (personId,courseId,scoId), so without this an assigned learner
  // could loop the persist action with fresh random scoIds and pile up orphan
  // ScoProgress rows that no reader ever surfaces (self-service storage bloat).
  if (!scos.some((s) => s.id === scoId)) {
    throw new LearningValidationError("This SCO is not part of the course.");
  }

  const sco = deriveStatus(cmi.lessonStatus);

  // Steps 1+2 (upsert this SCO, then recompute the course rollup from ALL SCOs) run
  // in one Serializable transaction. Without it, two concurrent commits for
  // different SCOs of the same (person, course) -- e.g. the course open in two tabs
  // -- can each read the SCO set before the other's write is visible and the last
  // writer clobbers a COMPLETE rollup with a stale IN_PROGRESS one, silently
  // blocking a learner who finished every SCO. Serializable makes Postgres abort the
  // loser of a conflicting pair; runSerializable retries it, and the retry reads the
  // winner's committed SCO and rolls up correctly.
  await runSerializable(async (tx) => {
    // 1. Upsert this SCO's state (untrusted TEXT fields bounded before they hit the row).
    const existingSco = await tx.scoProgress.findUnique({
      where: { personId_courseId_scoId: { personId, courseId, scoId } },
      select: { completedAt: true },
    });
    // Latch completion: once a SCO has completed (completedAt set), a later commit --
    // a review re-open reporting "incomplete"/"browsed", or the 30s autocommit --
    // must never downgrade it. Keeping the persisted lesson_status "completed" also
    // keeps the course rollup from silently reverting COMPLETE -> IN_PROGRESS and
    // un-clearing a volunteer who already finished (standard LMS behavior).
    const scoComplete = sco.completed || existingSco?.completedAt != null;
    const scoCompletedAt = scoComplete ? (existingSco?.completedAt ?? new Date()) : null;
    const scoData = {
      completedAt: scoCompletedAt,
      lessonStatus: scoComplete ? "completed" : capText(cmi.lessonStatus, MAX_LESSON_STATUS),
      scoreRaw: sanitizeScore(cmi.scoreRaw),
      suspendData: capText(cmi.suspendData, MAX_SUSPEND_DATA),
      lessonLocation: capText(cmi.lessonLocation, MAX_LESSON_LOCATION),
    };
    await tx.scoProgress.upsert({
      where: { personId_courseId_scoId: { personId, courseId, scoId } },
      create: { personId, courseId, scoId, ...scoData },
      update: scoData,
    });

    // 2. Recompute the course rollup over every SCO in the manifest.
    const rows = await tx.scoProgress.findMany({
      where: { personId, courseId },
      select: { scoId: true, lessonStatus: true, scoreRaw: true },
    });
    const statusById = new Map(rows.map((r) => [r.scoId, r.lessonStatus]));
    const roll = rollupStatus(scos.map((s) => statusById.get(s.id) ?? null));

    // Roll up the course score as the HIGHEST score among the SCOs that reported one
    // (eXeLearning/Moodle convention: the learner's best quiz score), or null when none
    // did. For a single-SCO course this is just that SCO's score.
    const scoreById = new Map(rows.map((r) => [r.scoId, r.scoreRaw]));
    const scoScores = scos
      .map((s) => scoreById.get(s.id))
      .filter((v): v is number => v != null);
    const rolledScore = scoScores.length ? sanitizeScore(Math.max(...scoScores)) : null;

    const existingCourse = await tx.courseProgress.findUnique({
      where: { personId_courseId: { personId, courseId } },
      select: { completedAt: true },
    });
    // Latch course completion too (defense in depth alongside the per-SCO latch):
    // a completed course never reverts on a later commit.
    const courseComplete = roll.completed || existingCourse?.completedAt != null;
    const completedAt = courseComplete ? (existingCourse?.completedAt ?? new Date()) : null;

    // lessonStatus is a rollup token so existing readers (dashboard, getMyCourses)
    // keep deriving the course status from CourseProgress unchanged.
    const courseData = {
      status: courseComplete ? ("COMPLETE" as const) : roll.status,
      completedAt,
      lessonStatus: courseComplete ? "completed" : "incomplete",
      scoreRaw: rolledScore,
      suspendData: null,
      lessonLocation: null,
    };
    await tx.courseProgress.upsert({
      where: { personId_courseId: { personId, courseId } },
      create: { personId, courseId, ...courseData },
      update: courseData,
    });
  });
}
