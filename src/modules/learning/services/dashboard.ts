import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { LearningAuthError } from "./errors";

async function requireViewer(actorId: string): Promise<void> {
  if (!(await can(actorId, "learning.view_progress"))) {
    throw new LearningAuthError("You do not have permission to view training progress.");
  }
}

export type CompletionRow = {
  personId: string;
  name: string;
  departmentCode: string;
  status: "COMPLETE" | "IN_PROGRESS" | "NOT_STARTED";
  completedAt: Date | null;
  hasLockedQuiz: boolean;
};

/** For one course: every active member of an assigned department in the active
 *  term, with their completion status. assignToAll courses cover all departments. */
export async function getCourseCompletion(courseId: string, viewerId: string): Promise<CompletionRow[]> {
  await requireViewer(viewerId);
  const course = await prisma.course.findUniqueOrThrow({
    where: { id: courseId },
    include: { departments: { select: { departmentId: true } } },
  });
  const term = await prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } });
  if (!term) return [];

  const deptFilter = course.assignToAll
    ? {}
    : { departmentId: { in: course.departments.map((d) => d.departmentId) } };

  const memberships = await prisma.termMembership.findMany({
    where: { termId: term.id, kind: "VOLUNTEER", status: "ACTIVE", ...deptFilter },
    include: { person: { select: { id: true, name: true } }, department: { select: { code: true } } },
  });

  const personIds = memberships.map((m) => m.person.id);
  const progress = new Map(
    (await prisma.courseProgress.findMany({ where: { courseId, personId: { in: personIds } } })).map((p) => [p.personId, p])
  );
  const lockedModulePersons = new Set(
    (
      await prisma.moduleProgress.findMany({
        where: { personId: { in: personIds }, locked: true, module: { courseId } },
        select: { personId: true },
      })
    ).map((m) => m.personId)
  );

  return memberships
    .map<CompletionRow>((m) => {
      const p = progress.get(m.person.id);
      const status = p ? p.status : "NOT_STARTED";
      return {
        personId: m.person.id,
        name: m.person.name,
        departmentCode: m.department.code,
        status,
        completedAt: p?.completedAt ?? null,
        hasLockedQuiz: lockedModulePersons.has(m.person.id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Clear a locked quiz module for a learner and open a fresh attempt window. */
export async function resetCourseQuiz(personId: string, moduleId: string, actorId: string): Promise<void> {
  if (!(await can(actorId, "learning.manage_courses"))) {
    throw new LearningAuthError("You do not have permission to reset quizzes.");
  }
  await prisma.moduleProgress.update({
    where: { personId_moduleId: { personId, moduleId } },
    data: { locked: false, lockResetAt: new Date() },
  });
  await recordAudit({ actorPersonId: actorId, action: "learning.quiz_reset", entityType: "CourseModule", entityId: moduleId, after: { personId } });
}

/** Active courses for the dashboard's course picker. */
export async function listCoursesForDashboard(viewerId: string): Promise<{ id: string; title: string }[]> {
  await requireViewer(viewerId);
  const courses = await prisma.course.findMany({ where: { isActive: true }, orderBy: { position: "asc" }, select: { id: true, title: true } });
  return courses;
}
