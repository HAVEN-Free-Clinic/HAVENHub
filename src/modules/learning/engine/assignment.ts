/** Pure assignment resolution. No DB. A member is assigned a course when it is
 *  active, has an uploaded SCORM package, and is either org-wide (assignToAll)
 *  or assigned to a department they belong to. A course that is inactive,
 *  package-less, or has no audience (no departments and not assignToAll) is a
 *  draft and is assigned to no one. Excluding package-less courses is what keeps
 *  an admin who assigns a course before uploading its package from locking every
 *  assigned member out of the onboarding gate with a requirement they can never
 *  complete (the player has no SCO to finish). */

export type AssignableCourse = {
  id: string;
  isActive: boolean;
  assignToAll: boolean;
  departmentIds: string[];
  /** True once a SCORM package has been ingested (Course.scormEntryHref set). */
  hasPackage: boolean;
};

export function coursesForMember(params: {
  courses: AssignableCourse[];
  memberDepartmentIds: string[];
}): string[] {
  const memberDepts = new Set(params.memberDepartmentIds);
  const out: string[] = [];
  for (const course of params.courses) {
    if (!course.isActive) continue;
    if (!course.hasPackage) continue;
    const assigned =
      course.assignToAll || course.departmentIds.some((d) => memberDepts.has(d));
    if (assigned) out.push(course.id);
  }
  return out;
}
