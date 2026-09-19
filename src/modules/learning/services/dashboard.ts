import { prisma } from "@/platform/db";
import { comparePersonName } from "@/platform/person-name";
import { can } from "@/platform/rbac/engine";
import { getActiveTerm } from "@/platform/terms/active-term";
import { recordAudit } from "@/platform/audit";
import { recomputeTrainingStanding } from "@/platform/training/standing";
import { deriveStatus } from "../engine/status";
import { LearningAuthError, LearningValidationError } from "./errors";
import { audienceToKind, courseHasContent } from "../engine/assignment";

async function requireViewer(actorId: string): Promise<void> {
  if (!(await can(actorId, "learning.view_progress"))) {
    throw new LearningAuthError("You do not have permission to view training progress.");
  }
}

export type CompletionRow = {
  personId: string;
  name: string;
  legalFirstName: string;
  lastName: string;
  departmentCode: string;
  status: "COMPLETE" | "IN_PROGRESS" | "NOT_STARTED";
  completedAt: Date | null;
  scoreRaw: number | null;
};

/** For one course: every active member of an assigned department in the active
 *  term, with their SCORM completion status + score. assignToAll covers all depts. */
export async function getCourseCompletion(courseId: string, viewerId: string): Promise<CompletionRow[]> {
  await requireViewer(viewerId);
  // findUnique (not ...OrThrow): the course id comes from the user-editable
  // ?course= param, so an unknown id must yield an empty table, not a 500.
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    include: { departments: { select: { departmentId: true } } },
  });
  if (!course) return [];
  // Mirror coursesForMember's assignment gate: an inactive or package-less course
  // is assigned to no one (per the package-less gate), so it has no required
  // learners to track. Returning [] keeps the dashboard's counting/labeling
  // consistent with the canonical resolver instead of listing every active member
  // as a NOT_STARTED (required-incomplete) learner for a course they were never
  // actually assigned.
  if (!course.isActive || !courseHasContent(course)) return [];
  // A training makeup course is assigned to no one (see coursesForMember), so
  // there is no roster of required learners to measure against. Its table is
  // the people who have opened it, in the cycle's term, which is where its
  // progress is recorded; who still owes it is the training roster's question.
  if (course.makeupForCycleId) return makeupCompletion(courseId, course.makeupForCycleId);
  const term = await getActiveTerm();
  if (!term) return [];

  const deptFilter = course.assignToAll
    ? {}
    : { departmentId: { in: course.departments.map((d) => d.departmentId) } };
  const kind = audienceToKind(course.audience);

  const memberships = await prisma.termMembership.findMany({
    where: { termId: term.id, status: "ACTIVE", ...deptFilter, ...(kind ? { kind } : {}) },
    include: {
      person: { select: { id: true, name: true, legalFirstName: true, lastName: true } },
      department: { select: { code: true } },
    },
  });

  const personIds = memberships.map((m) => m.person.id);
  // Scope by term for a PER_TERM course, mirroring getMyCourses/loadClearanceMap:
  // this roster is already built from the active term's memberships (`term` above),
  // so a PER_TERM course's rows from a DIFFERENT term would describe a completion
  // that does not apply to this term's roster. ONCE stays unscoped (today's
  // behavior, unchanged).
  const progressRows = await prisma.courseProgress.findMany({
    where: {
      courseId,
      personId: { in: personIds },
      ...(course.recurrence === "PER_TERM" ? { termId: term.id } : {}),
    },
    select: { personId: true, lessonStatus: true, scoreRaw: true, completedAt: true },
    // The map below is last-wins, and a ONCE course is read unscoped, so one
    // person can match more than one row (a course toggled to PER_TERM, run for
    // a term or two, then toggled back leaves a row per term). Without an order,
    // whichever row the planner happened to return won, so a director could see
    // an in-progress row beat the learner's real completion. Completed rows sort
    // last and therefore win; id is a TOTAL tiebreak, deliberately not createdAt,
    // which ties at the millisecond and is a known flake source in this repo.
    // Same defect and same fix as loadClearanceMap (audit 14, L4).
    orderBy: [{ completedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
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
        legalFirstName: m.person.legalFirstName,
        lastName: m.person.lastName,
        departmentCode: m.department.code,
        status,
        completedAt: status === "COMPLETE" ? (p?.completedAt ?? null) : null,
        scoreRaw: p?.scoreRaw ?? null,
      };
    })
    .sort(comparePersonName);
}

/** Completion rows for a training makeup course: everyone with progress on it
 *  in the cycle's term. */
async function makeupCompletion(courseId: string, cycleId: string): Promise<CompletionRow[]> {
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { termId: true, track: true } });
  if (!cycle) return [];
  const rows = await prisma.courseProgress.findMany({
    where: { courseId, termId: cycle.termId },
    select: {
      status: true,
      completedAt: true,
      scoreRaw: true,
      person: {
        select: {
          id: true,
          name: true,
          legalFirstName: true,
          lastName: true,
          memberships: {
            where: { termId: cycle.termId, kind: cycle.track, status: "ACTIVE" },
            select: { department: { select: { code: true } } },
            take: 1,
          },
        },
      },
    },
  });
  return rows
    .map<CompletionRow>((r) => ({
      personId: r.person.id,
      name: r.person.name,
      legalFirstName: r.person.legalFirstName,
      lastName: r.person.lastName,
      departmentCode: r.person.memberships[0]?.department.code ?? "",
      status: r.status === "COMPLETE" ? "COMPLETE" : "IN_PROGRESS",
      completedAt: r.status === "COMPLETE" ? r.completedAt : null,
      scoreRaw: r.scoreRaw,
    }))
    .sort(comparePersonName);
}

/**
 * Clear a learner's progress on a course so they can retake it.
 *
 * Progress is now per-term, so "reset" needs a scope decision: every term's rows,
 * or just the one this director is looking at? These rows are a compliance
 * artifact (did this person complete this course in this term), so wiping every
 * term would destroy the record that they genuinely completed it back when they
 * were actually in that term -- a much bigger loss than what the director asked
 * for by clicking "reset" on THIS term's roster (getCourseCompletion above, which
 * is itself scoped to the active term for a PER_TERM course).
 *
 * So: for a PER_TERM course, reset only the active term's rows, leaving prior
 * terms' completions on the record so a retake this term does not erase the fact
 * they finished it in an earlier one. For a ONCE course there is only ever the one
 * row (persistScoCmi always reuses it, never re-keys it to a new term), so scoping
 * the delete would either hit that same row or, if it happens to carry an older
 * term's id than whatever is "active" right now, silently find nothing and no-op
 * the reset the director just asked for -- so ONCE keeps the unscoped delete,
 * matching today's behavior and actually clearing the row being looked at.
 */
export async function resetCourseProgress(personId: string, courseId: string, actorId: string): Promise<void> {
  if (!(await can(actorId, "learning.manage_courses"))) {
    throw new LearningAuthError("You do not have permission to reset progress.");
  }
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { recurrence: true, makeupForCycle: { select: { termId: true, track: true } } },
  });
  let termFilter: { termId?: string } = {};
  if (course?.makeupForCycle) {
    // A makeup course records progress against its cycle's term only.
    termFilter = { termId: course.makeupForCycle.termId };
  } else if (course?.recurrence === "PER_TERM") {
    const term = await getActiveTerm();
    if (!term) throw new LearningValidationError("No active term to reset progress against.");
    termFilter = { termId: term.id };
  }
  // Delete every progress record in one transaction (mirrors the ingest-time
  // resetProgress reset) so we never leave an orphaned course rollup or per-SCO
  // or per-section rows if one delete fails. SectionQuizAttempt rows cascade
  // with their SectionProgress.
  await prisma.$transaction([
    prisma.courseProgress.deleteMany({ where: { personId, courseId, ...termFilter } }),
    prisma.scoProgress.deleteMany({ where: { personId, courseId, ...termFilter } }),
    prisma.sectionProgress.deleteMany({ where: { personId, courseId, ...termFilter } }),
  ]);
  // A makeup completion is what credited the morning; with it gone the
  // standing must be re-derived, or the credit would outlive its evidence.
  if (course?.makeupForCycle && termFilter.termId) {
    await recomputeTrainingStanding(prisma, {
      personId,
      termId: termFilter.termId,
      track: course.makeupForCycle.track,
    });
  }
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.progress_reset",
    entityType: "Course",
    entityId: courseId,
    after: { personId, termId: termFilter.termId ?? null },
  });
}

/** Active, packaged courses for the dashboard's course picker. Package-less courses
 *  are assigned to no one (per the package-less gate), so offering them would only
 *  surface an empty completion table. */
export async function listCoursesForDashboard(viewerId: string): Promise<{ id: string; title: string }[]> {
  await requireViewer(viewerId);
  return prisma.course.findMany({
    where: {
      isActive: true,
      OR: [{ kind: "SCORM", scormEntryHref: { not: null } }, { kind: "VIDEO", videoReady: true }],
    },
    orderBy: { position: "asc" },
    select: { id: true, title: true },
  });
}
