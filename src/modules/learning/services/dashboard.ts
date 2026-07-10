import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { getActiveTerm } from "@/platform/terms/active-term";
import { recordAudit } from "@/platform/audit";
import { deriveStatus } from "../engine/status";
import { LearningAuthError } from "./errors";
import { audienceToKind } from "../engine/assignment";

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
  // Mirror coursesForMember's assignment gate: an inactive or package-less course
  // is assigned to no one (per the package-less gate), so it has no required
  // learners to track. Returning [] keeps the dashboard's counting/labeling
  // consistent with the canonical resolver instead of listing every active member
  // as a NOT_STARTED (required-incomplete) learner for a course they were never
  // actually assigned.
  if (!course.isActive || course.scormEntryHref == null) return [];
  const term = await getActiveTerm();
  if (!term) return [];

  const deptFilter = course.assignToAll
    ? {}
    : { departmentId: { in: course.departments.map((d) => d.departmentId) } };
  const kind = audienceToKind(course.audience);

  const memberships = await prisma.termMembership.findMany({
    where: { termId: term.id, status: "ACTIVE", ...deptFilter, ...(kind ? { kind } : {}) },
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
  // Delete both progress records in one transaction (mirrors the ingest-time
  // resetProgress reset) so we never leave an orphaned course rollup or per-SCO
  // rows if one delete fails.
  await prisma.$transaction([
    prisma.courseProgress.deleteMany({ where: { personId, courseId } }),
    prisma.scoProgress.deleteMany({ where: { personId, courseId } }),
  ]);
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.progress_reset",
    entityType: "Course",
    entityId: courseId,
    after: { personId },
  });
}

/** Active, packaged courses for the dashboard's course picker. Package-less courses
 *  are assigned to no one (per the package-less gate), so offering them would only
 *  surface an empty completion table. */
export async function listCoursesForDashboard(viewerId: string): Promise<{ id: string; title: string }[]> {
  await requireViewer(viewerId);
  return prisma.course.findMany({
    where: { isActive: true, scormEntryHref: { not: null } },
    orderBy: { position: "asc" },
    select: { id: true, title: true },
  });
}
