/** Pure assignment resolution. No DB. A member is assigned a course when it is
 *  active, has an uploaded SCORM package, falls in scope (org-wide assignToAll or
 *  a department the member belongs to), and the member's matching membership kind
 *  satisfies the course audience. A course that is inactive, package-less, or has
 *  no scope (no departments and not assignToAll) is a draft assigned to no one.
 *  Excluding package-less courses keeps an admin who assigns a course before
 *  uploading its package from locking every assigned member out of the onboarding
 *  gate with a requirement they can never complete (the player has no SCO to
 *  finish). */
import type { CourseAudience, Track } from "@prisma/client";

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
