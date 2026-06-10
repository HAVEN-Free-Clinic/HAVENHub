import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { isCourseComplete, type ModuleState } from "../engine/completion";
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
  /** Module ids (within this course) where this person has a locked quiz. */
  lockedQuizModuleIds: string[];
};

/** For one course: every active member of an assigned department in the active
 *  term, with their completion status. assignToAll courses cover all departments. */
export async function getCourseCompletion(courseId: string, viewerId: string): Promise<CompletionRow[]> {
  await requireViewer(viewerId);
  const course = await prisma.course.findUniqueOrThrow({
    where: { id: courseId },
    include: {
      departments: { select: { departmentId: true } },
      modules: { select: { id: true, kind: true } },
    },
  });
  const term = await prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } });
  if (!term) return [];

  const deptFilter = course.assignToAll
    ? {}
    : { departmentId: { in: course.departments.map((d) => d.departmentId) } };

  // Fix 2: removed `kind: "VOLUNTEER"` — match any active member kind (VOLUNTEER or DIRECTOR)
  const memberships = await prisma.termMembership.findMany({
    where: { termId: term.id, status: "ACTIVE", ...deptFilter },
    include: { person: { select: { id: true, name: true } }, department: { select: { code: true } } },
  });

  const personIds = memberships.map((m) => m.person.id);
  const courseModuleIds = course.modules.map((m) => m.id);

  // Fix 3: load module-level progress for ALL members in one batch (no N+1)
  const moduleProgressRows = await prisma.moduleProgress.findMany({
    where: { personId: { in: personIds }, moduleId: { in: courseModuleIds } },
    select: { personId: true, moduleId: true, completedAt: true, locked: true },
  });

  // Which (personId, moduleId) pairs have a passing quiz attempt
  const passingProgressRows = await prisma.moduleProgress.findMany({
    where: {
      personId: { in: personIds },
      moduleId: { in: courseModuleIds },
      attempts: { some: { passed: true } },
    },
    select: { personId: true, moduleId: true },
  });
  const passingSet = new Set(passingProgressRows.map((r) => `${r.personId}:${r.moduleId}`));

  // Persisted completedAt for members who have a CourseProgress row (Fix 3: use only when live status = COMPLETE)
  const courseProgressRows = await prisma.courseProgress.findMany({
    where: { courseId, personId: { in: personIds } },
    select: { personId: true, completedAt: true },
  });
  const persistedCompletedAt = new Map(courseProgressRows.map((p) => [p.personId, p.completedAt]));

  // Build per-person module progress lookup
  type ModProgressEntry = { completedAt: Date | null; locked: boolean };
  const progressByPersonModule = new Map<string, ModProgressEntry>();
  // Track which persons have ANY ModuleProgress row for this course (locked/failed rows count).
  const personsWithAnyProgressRow = new Set<string>();
  for (const row of moduleProgressRows) {
    progressByPersonModule.set(`${row.personId}:${row.moduleId}`, {
      completedAt: row.completedAt,
      locked: row.locked,
    });
    personsWithAnyProgressRow.add(row.personId);
  }

  // De-duplicate by personId so multi-dept memberships don't produce duplicate rows.
  // Keep first occurrence (sorted later by name, so the original sort order is preserved).
  const seenPersonIds = new Set<string>();
  const uniqueMemberships = memberships.filter((m) => {
    if (seenPersonIds.has(m.person.id)) return false;
    seenPersonIds.add(m.person.id);
    return true;
  });

  return uniqueMemberships
    .map<CompletionRow>((m) => {
      const pid = m.person.id;

      // Fix 3: derive live status from module states
      const states = course.modules.map<ModuleState>((mod) => {
        const entry = progressByPersonModule.get(`${pid}:${mod.id}`);
        return {
          kind: mod.kind,
          completed: entry?.completedAt != null,
          quizPassed: passingSet.has(`${pid}:${mod.id}`),
        };
      });

      // IN_PROGRESS when the person has any ModuleProgress row for this course
      // (locked or failed-only rows count — they represent real engagement).
      const hasAnyEngagement = personsWithAnyProgressRow.has(pid);
      const complete = isCourseComplete(states);
      const status: CompletionRow["status"] = complete
        ? "COMPLETE"
        : hasAnyEngagement
        ? "IN_PROGRESS"
        : "NOT_STARTED";

      // Fix 3: show persisted completedAt only when live status is COMPLETE
      const completedAt = complete ? (persistedCompletedAt.get(pid) ?? null) : null;

      // Fix 1: collect locked quiz module ids for this person in this course
      const lockedQuizModuleIds = course.modules
        .filter((mod) => {
          const entry = progressByPersonModule.get(`${pid}:${mod.id}`);
          return entry?.locked === true;
        })
        .map((mod) => mod.id);

      return {
        personId: pid,
        name: m.person.name,
        departmentCode: m.department.code,
        status,
        completedAt,
        lockedQuizModuleIds,
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
