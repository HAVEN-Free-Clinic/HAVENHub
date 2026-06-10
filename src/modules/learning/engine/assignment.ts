/** Pure assignment resolution. No DB. A member is assigned an active course
 *  when it is org-wide (assignToAll) or assigned to a department they belong to.
 *  A course that is active but has no departments and is not assignToAll is a
 *  draft and is assigned to no one. */

export type AssignableCourse = {
  id: string;
  isActive: boolean;
  assignToAll: boolean;
  departmentIds: string[];
};

export function coursesForMember(params: {
  courses: AssignableCourse[];
  memberDepartmentIds: string[];
}): string[] {
  const memberDepts = new Set(params.memberDepartmentIds);
  const out: string[] = [];
  for (const course of params.courses) {
    if (!course.isActive) continue;
    const assigned =
      course.assignToAll || course.departmentIds.some((d) => memberDepts.has(d));
    if (assigned) out.push(course.id);
  }
  return out;
}
