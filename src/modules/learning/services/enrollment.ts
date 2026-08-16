import type { CourseRecurrence, Prisma } from "@prisma/client";
import { prisma, runSerializable } from "@/platform/db";
import { log } from "@/platform/logging";
import { getActiveTerm } from "@/platform/terms/active-term";
import { captureEvent, flushEvents } from "@/platform/posthog/capture";
import { activeTermGroup } from "@/platform/posthog/groups";
import {
  coursesForMember,
  coursesSatisfiableInTerm,
  splitByRecurrence,
  type AssignableCourse,
  type MemberMembership,
} from "../engine/assignment";
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

/**
 * Resolve the active-course ids assigned to this person in a term. Defaults to
 * the active term; pass a termId to compute assignment for a next term, so a
 * member's own next-term clearance checklist and the schedule builder's
 * "not cleared" banner agree about learning requirements.
 */
async function assignedCourseIds(personId: string, termIdOverride?: string): Promise<string[]> {
  const termId = termIdOverride ?? (await activeTermId());
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

/** Either the singleton client or an open transaction: whichever the caller has in hand. */
type ProgressClient = typeof prisma | Prisma.TransactionClient;

/**
 * Resolve which term's CourseProgress/ScoProgress row a SCORM commit belongs to, given
 * the course's recurrence. This is the fix for the ScoProgress trap (see persistScoCmi):
 * both tables are keyed per term now, but that only reopens a recurring course if the
 * write path actually resolves a *different* term's row once the term changes, instead
 * of always continuing to write the same one.
 *
 * PER_TERM: always the current active term. Each term's attempt is its own row, full
 * stop. A prior term's rows are never resolved here, so their completion latch cannot
 * leak forward and auto-complete a fresh term from stale data.
 *
 * ONCE: reuse whichever term an existing row already carries, so a course that never
 * reopens keeps writing through the SAME row for its whole life, exactly like the
 * single pre-migration row did (today's behavior, preserved).
 *
 * An earlier version of this filtered `termId: { not: null }` here, to skip legacy
 * rows the backfill had left null. Do NOT re-add that. It is what made a null row
 * invisible to this resolver, so the next commit forked a SECOND row, and the
 * unscoped ONCE readers then collapsed last-wins onto the stale one and blocked the
 * learner permanently. The migration now gives every row a term and the column is
 * NOT NULL, so there is nothing to skip and the filter is no longer expressible.
 *
 * Falls back to the active term when no matching row exists yet (the first-ever
 * commit, either recurrence). Never returns null: the caller has already confirmed an
 * active term exists (isCourseAssignedTo requires one to authorize), so this never
 * hands back a term-less key, which would stop protecting the per-term unique
 * constraint the moment it was used to write a row (see schema notes on termId).
 */
async function resolveProgressTermId(
  client: ProgressClient,
  personId: string,
  courseId: string,
  recurrence: CourseRecurrence,
  activeTerm: string
): Promise<string> {
  if (recurrence === "PER_TERM") return activeTerm;
  // A ONCE course keeps writing whichever row already exists, so its single
  // pre-migration row never fragments across terms. There is at most one, and
  // the unique index guarantees it now that termId is NOT NULL.
  //
  // An earlier version filtered `termId: { not: null }` here to skip legacy
  // rows the backfill had left null. That filter is what made a null row
  // invisible to the resolver, so the next commit forked a second row and the
  // unscoped ONCE readers then collapsed to the stale one, blocking the
  // learner permanently. The migration now leaves no null rows and the column
  // is NOT NULL, so the filter is both unnecessary and no longer expressible.
  const existing = await client.courseProgress.findFirst({
    where: { personId, courseId },
    select: { termId: true },
    // Deterministic for the same reason the readers are: after a PER_TERM
    // round trip a ONCE course can have a row per term, and the commit should
    // keep extending the completed one.
    orderBy: [{ completedAt: { sort: "desc", nulls: "last" } }],
  });
  return existing?.termId ?? activeTerm;
}

export type LearnerStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE";

export type MyCourseRow = {
  id: string;
  title: string;
  description: string | null;
  status: LearnerStatus;
};

export async function getMyCourses(personId: string, termId?: string): Promise<MyCourseRow[]> {
  const ids = await assignedCourseIds(personId, termId);
  if (ids.length === 0) return [];
  const assigned = await prisma.course.findMany({
    where: { id: { in: ids } },
    orderBy: { position: "asc" },
    select: { id: true, title: true, description: true, recurrence: true },
  });

  // A PER_TERM course is only satisfiable in the ACTIVE term, because that is the
  // only term persistScoCmi will ever write an attempt against. Listing it for a
  // next term put a permanently-NOT_STARTED row on the member's next-term
  // checklist that no amount of studying could clear (audit 14, L1). See
  // coursesSatisfiableInTerm; loadClearanceMap applies the identical rule, which
  // is what keeps this checklist and the builder's banner agreeing.
  const activeTerm = await activeTermId();
  const resolvedTermId = termId ?? activeTerm;
  const courses = coursesSatisfiableInTerm(assigned, resolvedTermId === activeTerm);
  if (courses.length === 0) return [];

  // Scope the progress lookup by term for PER_TERM courses only; ONCE courses stay
  // unscoped so a prior-term completion still counts (today's behavior, unchanged --
  // this is the regression bar for the whole branch). The term is whichever one
  // assignedCourseIds just resolved above (the passed override, or else the active
  // term), so a PER_TERM course's status agrees with which term this call is
  // actually answering assignment for -- including a next-term checklist call, not
  // just the live term.
  const { onceIds, perTermIds } = splitByRecurrence(courses);
  const progress = await prisma.courseProgress.findMany({
    where: {
      personId,
      OR: [
        ...(onceIds.length ? [{ courseId: { in: onceIds } }] : []),
        ...(perTermIds.length && resolvedTermId ? [{ courseId: { in: perTermIds }, termId: resolvedTermId }] : []),
      ],
    },
    select: { courseId: true, lessonStatus: true },
    // A ONCE course is read unscoped, so it can see more than one row: a course
    // toggled to PER_TERM, run for a term or two, then toggled back leaves a row
    // per term behind. The Map below is last-wins, so without a deterministic
    // order an unrelated in-progress row could beat a real completion and block
    // the learner. Completed rows sort last and therefore win.
    orderBy: [{ completedAt: { sort: "asc", nulls: "first" } }],
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
    select: { id: true, title: true, description: true, scormScos: true, scormEntryHref: true, recurrence: true },
  });
  const scos = courseScos(course);

  // Scope both the per-SCO cmi (the player's resume state) and the course rollup by
  // term for PER_TERM courses only, mirroring getMyCourses; ONCE stays unscoped so a
  // prior-term completion still reads COMPLETE (today's behavior).
  //
  // Scoping scoRows too, not just the rollup, matters here specifically: ScormPlayer
  // seeds its SCORM API directly from each SCO's cmi.lessonStatus/suspendData on
  // mount (ScormPlayer.tsx's installApi). An unscoped read would hand a reopened
  // PER_TERM course's player a prior term's "completed" cmi the moment it loads,
  // showing the completion banner and re-latching on the very next autocommit before
  // the learner does anything this term -- the same ships-inert trap Task 2 closed
  // on the write-side rollup (persistScoCmi's SCO findMany), reopened here on the
  // read side that feeds the player instead of the gate.
  const activeTerm = await activeTermId();
  const termFilter = course.recurrence === "PER_TERM" && activeTerm ? { termId: activeTerm } : {};

  const scoRows = await prisma.scoProgress.findMany({ where: { personId, courseId, ...termFilter } });
  const byId = new Map(scoRows.map((r) => [r.scoId, r]));

  const rollup = await prisma.courseProgress.findFirst({
    where: { personId, courseId, ...termFilter },
    select: { status: true },
    // Unscoped for ONCE, so more than one row can match after a PER_TERM
    // round trip. Prefer the completed one rather than whichever the planner
    // happens to return.
    orderBy: [{ completedAt: { sort: "desc", nulls: "last" } }],
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
  // the rollup in step 2 (no second query). recurrence drives which term this commit
  // is recorded against, below.
  const course = await prisma.course.findUniqueOrThrow({
    where: { id: courseId },
    select: { scormScos: true, scormEntryHref: true, title: true, recurrence: true },
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

  // Which term this attempt is recorded against comes from the SAME source that just
  // authorized the commit: isCourseAssignedTo (above) resolves the current active
  // term to decide whether this course is assigned right now, so re-deriving it here
  // is the active term at the moment of this exact commit, not a caller-supplied value
  // that could be stale or spoofed, and not something read off a SCORM "session" --
  // the runtime has no session object of its own, it is a bare CMI snapshot POST.
  // Using anything else (e.g. trusting a term id from the request body) would let a
  // commit land against a term the person never worked in, which the brief calls out
  // as worse than the bug this task fixes.
  const activeTerm = await activeTermId();
  if (!activeTerm) {
    // Should be unreachable: isCourseAssignedTo above already required a non-null
    // active term to authorize this call. Guarded explicitly rather than ever falling
    // through to a null termId, which would stop being protected by the per-term
    // unique constraint the moment a row was written without one.
    throw new LearningValidationError("No active term to record this attempt against.");
  }

  // Steps 1+2 (upsert this SCO, then recompute the course rollup from ALL SCOs) run
  // in one Serializable transaction. Without it, two concurrent commits for
  // different SCOs of the same (person, course) -- e.g. the course open in two tabs
  // -- can each read the SCO set before the other's write is visible and the last
  // writer clobbers a COMPLETE rollup with a stale IN_PROGRESS one, silently
  // blocking a learner who finished every SCO. Serializable makes Postgres abort the
  // loser of a conflicting pair; runSerializable retries it, and the retry reads the
  // winner's committed SCO and rolls up correctly.
  const transitions = await runSerializable(async (tx) => {
    // Resolve the term this whole commit (both tables) writes through. See
    // resolveProgressTermId for the PER_TERM vs ONCE distinction; the key point is
    // that a PER_TERM course's queries below are scoped to termId = activeTerm and
    // never touch a prior term's rows, which is what lets it reopen instead of
    // auto-completing from stale ScoProgress rows the moment it recurs.
    const termId = await resolveProgressTermId(tx, personId, courseId, course.recurrence, activeTerm);

    // 1. Upsert this SCO's state (untrusted TEXT fields bounded before they hit the row).
    const existingSco = await tx.scoProgress.findUnique({
      where: { personId_courseId_scoId_termId: { personId, courseId, scoId, termId } },
      select: { completedAt: true, scoreRaw: true, suspendData: true, lessonLocation: true },
    });
    // Latch completion: once a SCO has completed (completedAt set), a later commit --
    // a review re-open reporting "incomplete"/"browsed", or the 30s autocommit --
    // must never downgrade it. Keeping the persisted lesson_status "completed" also
    // keeps the course rollup from silently reverting COMPLETE -> IN_PROGRESS and
    // un-clearing a volunteer who already finished (standard LMS behavior).
    const scoComplete = sco.completed || existingSco?.completedAt != null;
    const scoCompletedAt = scoComplete ? (existingSco?.completedAt ?? new Date()) : null;

    // A completion on the FIRST commit for this SCO, with no prior progress row at
    // all, is the signature of a forged CMI snapshot.
    //
    // The beacon (api/learning/persist-cmi) authenticates the learner correctly but
    // takes the CONTENT of `cmi` on trust, and deriveStatus is a plain string match
    // on lessonStatus, so a POST of {lessonStatus: "passed"} marks a SCO complete
    // without the content ever being loaded. That is not a defect unique to this
    // app: SCORM 1.2 runs the courseware client-side and the package itself calls
    // LMSSetValue("cmi.core.lesson_status", ...), so the learner's browser IS the
    // authority by design and no SCORM LMS can close it without abandoning the
    // standard. What makes it matter here is that completion LATCHES (above) and
    // feeds the /get-started gate, the clinic clearance badge and the Epic roll-up,
    // and the only reset is a package re-upload that wipes EVERY learner's progress.
    //
    // So this does not refuse: an honest short SCO can legitimately finish inside
    // one commit window. It makes the shape visible, because an ordinary learner
    // autocommits every 30s while they work and therefore almost always has a prior
    // row (audit 14, UNAUTH-05).
    if (sco.completed && !existingSco) {
      log.warn("[learning] SCO completed on its first commit, with no prior progress", {
        personId,
        courseId,
        scoId,
        termId,
        lessonStatus: cmi.lessonStatus,
      });
    }
    // Preserve a saved score / resume point / suspend_data when the incoming
    // snapshot omits it (null), instead of overwriting it. Revisiting an
    // already-scored SCO in the same session re-seeds its SCORM API from the stale
    // server snapshot, so on leave LMSFinish fires with null score/suspend/
    // location; the client's snapshot() maps the blank API fields to null. Those
    // are ABSENT values, not intentional clears -- overwriting them dropped the
    // learner's quiz score (and the director-visible rollup) and their in-page
    // resume position (#19). A real numeric score (including 0) or a non-null
    // string still updates as before; lessonStatus is already latched above.
    const scoData = {
      completedAt: scoCompletedAt,
      lessonStatus: scoComplete ? "completed" : capText(cmi.lessonStatus, MAX_LESSON_STATUS),
      scoreRaw: sanitizeScore(cmi.scoreRaw) ?? existingSco?.scoreRaw ?? null,
      suspendData: capText(cmi.suspendData, MAX_SUSPEND_DATA) ?? existingSco?.suspendData ?? null,
      lessonLocation: capText(cmi.lessonLocation, MAX_LESSON_LOCATION) ?? existingSco?.lessonLocation ?? null,
    };
    await tx.scoProgress.upsert({
      where: { personId_courseId_scoId_termId: { personId, courseId, scoId, termId } },
      create: { personId, courseId, scoId, termId, ...scoData },
      update: scoData,
    });

    // 2. Recompute the course rollup over every SCO in the manifest, scoped to THIS
    // term. This termId filter is the fix for the ScoProgress trap: without it, a
    // PER_TERM course reopening in a new term would pull in the prior term's
    // "completed" SCO rows here, roll up complete, and hand the fresh CourseProgress
    // row below a completedAt it never earned this term -- shipping the whole
    // feature inert while every course-level-only test kept passing.
    const rows = await tx.scoProgress.findMany({
      where: { personId, courseId, termId },
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
      where: { personId_courseId_termId: { personId, courseId, termId } },
      select: { completedAt: true },
    });
    // Latch course completion too (defense in depth alongside the per-SCO latch):
    // a completed course never reverts on a later commit. Scoped to termId along
    // with everything else above, so this latch follows THIS term's row -- a prior
    // term's completedAt is never read here, which is what lets a PER_TERM course's
    // fresh term start uncompleted instead of latching onto an old completion.
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
      where: { personId_courseId_termId: { personId, courseId, termId } },
      create: { personId, courseId, termId, ...courseData },
      update: courseData,
    });

    // Transition flags for authoritative analytics, computed against the
    // once-only `completedAt` stamps so each event fires exactly once. Returned
    // (not captured here) so a Serializable retry never double-fires.
    return {
      courseStarted: !existingCourse,
      scoNewlyCompleted: sco.completed && !existingSco?.completedAt,
      courseNewlyCompleted: roll.completed && !existingCourse?.completedAt,
    };
  });

  // Fire after commit so events reflect the committed state. The authoritative
  // server-side course_completed replaces the best-effort client event.
  if (
    transitions.courseStarted ||
    transitions.scoNewlyCompleted ||
    transitions.courseNewlyCompleted
  ) {
    const groups = await activeTermGroup();
    if (transitions.courseStarted) {
      await captureEvent({ event: "course_started", distinctId: personId, properties: { course_id: courseId }, groups, flush: false });
    }
    if (transitions.scoNewlyCompleted) {
      await captureEvent({ event: "sco_completed", distinctId: personId, properties: { course_id: courseId, sco_id: scoId }, groups, flush: false });
    }
    if (transitions.courseNewlyCompleted) {
      await captureEvent({ event: "course_completed", distinctId: personId, properties: { course_id: courseId, sco_count: scos.length }, groups, flush: false });
    }
    await flushEvents();
  }
}
