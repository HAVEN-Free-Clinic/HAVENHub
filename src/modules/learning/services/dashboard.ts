import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { getActiveTerm } from "@/platform/terms/active-term";
import { recordAudit } from "@/platform/audit";
import { deriveStatus } from "../engine/status";
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
  scoreRaw: number | null;
};

/** For one course: every active member of an assigned department in the active
 *  term, with their SCORM completion status + score. assignToAll covers all depts. */
export async function getCourseCompletion(courseId: string, viewerId: string): Promise<CompletionRow[]> {
  await requireViewer(viewerId);
  const course = await prisma.course.findUniqueOrThrow({
    where: { id: courseId },
    include: { departments: { select: { departmentId: true } } },
  });
  const term = await getActiveTerm();
  if (!term) return [];

  const deptFilter = course.assignToAll
    ? {}
    : { departmentId: { in: course.departments.map((d) => d.departmentId) } };

  const memberships = await prisma.termMembership.findMany({
    where: { termId: term.id, status: "ACTIVE", ...deptFilter },
    include: { person: { select: { id: true, name: true } }, department: { select: { code: true } } },
  });

  const personIds = memberships.map((m) => m.person.id);
  const progressRows = await prisma.courseProgress.findMany({
    where: { courseId, personId: { in: personIds } },
    select: { personId: true, lessonStatus: true, scoreRaw: true, completedAt: true },
  });
  const byPerson = new Map(progressRows.map((p) => [p.personId, p]));

  // De-duplicate by personId so multi-dept memberships don't double-list a learner.
  const seen = new Set<string>();
  const unique = memberships.filter((m) => {
    if (seen.has(m.person.id)) return false;
    seen.add(m.person.id);
    return true;
  });

  return unique
    .map<CompletionRow>((m) => {
      const p = byPerson.get(m.person.id);
      const status: CompletionRow["status"] = !p
        ? "NOT_STARTED"
        : deriveStatus(p.lessonStatus).status;
      return {
        personId: m.person.id,
        name: m.person.name,
        departmentCode: m.department.code,
        status,
        completedAt: status === "COMPLETE" ? (p?.completedAt ?? null) : null,
        scoreRaw: p?.scoreRaw ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Clear a learner's progress on a course so they can retake it. */
export async function resetCourseProgress(personId: string, courseId: string, actorId: string): Promise<void> {
  if (!(await can(actorId, "learning.manage_courses"))) {
    throw new LearningAuthError("You do not have permission to reset progress.");
  }
  await prisma.courseProgress.deleteMany({ where: { personId, courseId } });
  await prisma.scoProgress.deleteMany({ where: { personId, courseId } });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.progress_reset",
    entityType: "Course",
    entityId: courseId,
    after: { personId },
  });
}

/** Active courses for the dashboard's course picker. */
export async function listCoursesForDashboard(viewerId: string): Promise<{ id: string; title: string }[]> {
  await requireViewer(viewerId);
  return prisma.course.findMany({ where: { isActive: true }, orderBy: { position: "asc" }, select: { id: true, title: true } });
}
