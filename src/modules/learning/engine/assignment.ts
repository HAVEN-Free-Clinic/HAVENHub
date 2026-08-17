/** Pure assignment resolution. No DB. A member is assigned a course when it is
 *  active, has an uploaded SCORM package, falls in scope (org-wide assignToAll or
 *  a department the member belongs to), and the member's matching membership kind
 *  satisfies the course audience. A course that is inactive, package-less, or has
 *  no scope (no departments and not assignToAll) is a draft assigned to no one.
 *  Excluding package-less courses keeps an admin who assigns a course before
 *  uploading its package from locking every assigned member out of the onboarding
 *  gate with a requirement they can never complete (the player has no SCO to
 *  finish). */
import type { CourseAudience, CourseRecurrence, Track } from "@prisma/client";

export type AssignableCourse = {
  id: string;
  isActive: boolean;
  assignToAll: boolean;
  departmentIds: string[];
  /** True once a SCORM package has been ingested (Course.scormEntryHref set). */
  hasPackage: boolean;
  /** Who the course targets: EVERYONE, DIRECTORS, or VOLUNTEERS. */
  audience: CourseAudience;
};

/** One of the member's active memberships: the department and the kind held in it. */
export type MemberMembership = { departmentId: string; kind: Track };

/** The membership kind a non-EVERYONE audience requires, or null for EVERYONE. */
export function audienceToKind(audience: CourseAudience): Track | null {
  switch (audience) {
    case "DIRECTORS":
      return "DIRECTOR";
    case "VOLUNTEERS":
      return "VOLUNTEER";
    default:
      return null; // EVERYONE
  }
}

/** True when a membership of this kind satisfies the course audience. */
export function kindMatchesAudience(kind: Track, audience: CourseAudience): boolean {
  const required = audienceToKind(audience);
  return required === null || kind === required;
}

/**
 * Split a batch of courses' ids by whether their progress lookup must be scoped
 * to a term. PER_TERM courses go in `perTermIds` (a caller must filter by the
 * relevant termId); ONCE courses go in `onceIds` and stay unscoped, preserving
 * today's behavior (a completion counts forever). Shared so every progress
 * reader (getMyCourses, loadClearanceMap, ...) applies the exact same
 * recurrence rule instead of each re-deriving it and risking drift between
 * the checklist and the schedule builder's clearance map.
 */
export function splitByRecurrence<T extends { id: string; recurrence: CourseRecurrence }>(
  courses: T[]
): { onceIds: string[]; perTermIds: string[] } {
  const onceIds: string[] = [];
  const perTermIds: string[] = [];
  for (const c of courses) {
    (c.recurrence === "PER_TERM" ? perTermIds : onceIds).push(c.id);
  }
  return { onceIds, perTermIds };
}

/**
 * Narrow a course list to the ones a member can actually COMPLETE for the term
 * being asked about.
 *
 * The read side of learning is term-aware: getMyCourses and loadClearanceMap both
 * accept a termId so a member's next-term checklist and the schedule builder's
 * "not cleared" banner agree. The WRITE side is not, and cannot sensibly be: a
 * SCORM commit is a bare CMI snapshot POST with no term in it, so persistScoCmi
 * records the attempt against the term the learner is working in right now (the
 * ACTIVE one) and isCourseAssignedTo authorizes against that same term.
 *
 * So for a PLANNING (next) term, a PER_TERM course's progress row can never come
 * into existence: it is read from termId = next, written to termId = active. It
 * read NOT_STARTED forever, which made every member permanently "not cleared" on
 * the next-term builder banner, their own next-term checklist and the Epic
 * roll-up, with no action anyone could take to clear it (audit 14, L1).
 *
 * Dropping the course from the non-active term is the smaller of the two fixes:
 * threading a term through the write path would mean trusting (or inventing) a
 * term for a commit that carries none, and would let a learner bank a completion
 * for a term they are not yet in. A requirement nobody can satisfy asserts an
 * outstanding item nobody can clear, so it is not a requirement for that term --
 * it becomes one the moment that term goes ACTIVE. ONCE courses are unaffected:
 * a completion counts forever, so it is satisfiable in any term.
 */
export function coursesSatisfiableInTerm<T extends { recurrence: CourseRecurrence }>(
  courses: T[],
  isActiveTerm: boolean
): T[] {
  return isActiveTerm ? courses : courses.filter((c) => c.recurrence !== "PER_TERM");
}

export function coursesForMember(params: {
  courses: AssignableCourse[];
  memberships: MemberMembership[];
}): string[] {
  const out: string[] = [];
  for (const course of params.courses) {
    if (!course.isActive) continue;
    if (!course.hasPackage) continue;
    const assigned = params.memberships.some(
      (m) =>
        (course.assignToAll || course.departmentIds.includes(m.departmentId)) &&
        kindMatchesAudience(m.kind, course.audience)
    );
    if (assigned) out.push(course.id);
  }
  return out;
}
