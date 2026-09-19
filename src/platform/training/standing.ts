/**
 * What a volunteer owes on training day, and the one writer of it.
 *
 * Training day has two parts: the morning session and the afternoon mock
 * clinic. Each is OWED, NOT_REQUIRED, or satisfied (attended, made up online,
 * marked off). A Training row is COMPLETE exactly when neither part is OWED,
 * which is what lets every existing reader of Training.status (the get-started
 * gate, clearance, the dashboard, reminders, the roster) enforce these rules
 * without knowing them.
 *
 * The rules, as ops set them on 2026-09-19:
 *
 *   - Non-clinical: the morning is owed until attended or made up through the
 *     online course; mock clinic is owed until attended or marked off by IT
 *     (their director arranges or waives the make-up first).
 *   - Clinical, new: excused from the morning; mock clinic owed as above.
 *   - Clinical, returning: owes neither.
 *   - A volunteer with any non-clinical membership that term follows the
 *     non-clinical rules. Directors keep the old rule: the morning only.
 *
 * Every part is DERIVED from facts on each recompute (attendance rows, the
 * makeup course's progress, the mark-off), never latched, so removing a
 * check-in or resetting course progress takes the credit back with it. The
 * one exception is the retired quiz: a QUIZ morning is history nothing can
 * re-derive, so it is kept.
 *
 * Lives in platform, not recruitment, because three modules change the facts
 * it reads: recruitment (check-ins, IT mark-offs), learning (the online makeup
 * course), and the reminders sweep. Modules may not import each other.
 */
import type { TrainingMethod, TrainingPartStatus, Track } from "@prisma/client";
import type { TransactionClient } from "@/platform/db";
import { prisma } from "@/platform/db";

type Db = TransactionClient | typeof prisma;

export type TrainingDayFacts = {
  track: Track;
  /** True when the person holds at least one membership of the track that
   *  term and every one of them is in a clinical department. */
  clinical: boolean;
  /** A renewal this cycle (or, with no application to read, a member of an
   *  earlier term). A transfer is new: new to the department it moved into. */
  returning: boolean;
  attendedMorning: boolean;
  attendedMockClinic: boolean;
  /** Whether the term's training has a mock clinic at all. Without one there
   *  is nothing to owe. */
  hasMockClinic: boolean;
  completedMakeupCourse: boolean;
  /** IT marked mock clinic off (mockClinicMarkedAt is set). The marker fields
   *  are the fact; recompute never clears them, only an explicit undo does, so
   *  a mark-off survives a check-in that is later removed. */
  markedOff: boolean;
  /** Passed the retired makeup quiz: a passed QuizAttempt on the row, or a row
   *  already carrying a QUIZ morning. History nothing else can re-derive. */
  passedRetiredQuiz: boolean;
};

export type TrainingDayParts = { morning: TrainingPartStatus; mockClinic: TrainingPartStatus };

/** The two parts, from the facts. Pure. */
export function trainingDayParts(f: TrainingDayFacts): TrainingDayParts {
  const volunteer = f.track === "VOLUNTEER";
  const clinical = volunteer && f.clinical;

  const morning: TrainingPartStatus = f.attendedMorning
    ? "ATTENDED"
    : f.completedMakeupCourse
      ? "ONLINE_COURSE"
      : f.passedRetiredQuiz
        ? "QUIZ"
        : clinical
          ? "NOT_REQUIRED"
          : "OWED";

  const mockClinic: TrainingPartStatus = !volunteer || !f.hasMockClinic
    ? "NOT_REQUIRED"
    : f.attendedMockClinic
      ? "ATTENDED"
      : f.markedOff
        ? "MARKED_OFF"
        : clinical && f.returning
          ? "NOT_REQUIRED"
          : "OWED";

  return { morning, mockClinic };
}

export function partsComplete(parts: TrainingDayParts): boolean {
  return parts.morning !== "OWED" && parts.mockClinic !== "OWED";
}

/** How the morning was satisfied, in the older vocabulary Training.completedVia
 *  still carries for its readers. Null when the morning was not required. */
function completedViaFor(morning: TrainingPartStatus): TrainingMethod | null {
  switch (morning) {
    case "ATTENDED":
      return "ATTENDANCE";
    case "QUIZ":
      return "QUIZ";
    case "ONLINE_COURSE":
      return "ONLINE_COURSE";
    default:
      return null;
  }
}

/** The term's designated training cycle for a track. Mirrors
 *  getTrainingCycleForTerm, which platform code cannot import. */
async function designatedCycle(db: Db, termId: string, track: Track) {
  return db.recruitmentCycle.findFirst({
    where: { termId, track, isTermTraining: true },
    select: { id: true, termId: true, track: true },
  });
}

/** Whether the person is returning for this cycle. */
async function isReturning(db: Db, personId: string, cycleId: string, termId: string, track: Track): Promise<boolean> {
  const contracts = await db.onboardingContract.findMany({
    where: { promotedPersonId: personId, acceptance: { application: { cycleId } } },
    select: { acceptance: { select: { application: { select: { applicantType: true } } } } },
  });
  if (contracts.length > 0) {
    return contracts.some((c) => c.acceptance.application.applicantType === "RENEWAL");
  }
  // Nobody promoted them through this cycle (added to the roster by hand, or
  // imported). A membership in an earlier term is the best evidence left.
  const term = await db.term.findUnique({ where: { id: termId }, select: { startDate: true } });
  if (!term) return false;
  const earlier = await db.termMembership.count({
    where: { personId, kind: track, termId: { not: termId }, term: { startDate: { lt: term.startDate } } },
  });
  return earlier > 0;
}

/** Gather the facts for one person, term, and track. Null when the term has no
 *  designated training cycle for the track, i.e. nothing to compute. */
export async function loadTrainingDayFacts(
  db: Db,
  args: { personId: string; termId: string; track: Track }
): Promise<{ cycleId: string; facts: TrainingDayFacts } | null> {
  const { personId, termId, track } = args;
  const cycle = await designatedCycle(db, termId, track);
  if (!cycle) return null;

  const eventScope = { termId, cycle: { track } };
  const [memberships, attendance, mockClinicEvents, row, makeup, returning] = await Promise.all([
    db.termMembership.findMany({
      where: { personId, termId, kind: track, status: "ACTIVE" },
      select: { department: { select: { isClinical: true } } },
    }),
    db.eventAttendance.findMany({
      where: { personId, event: { ...eventScope, kind: { in: ["TRAINING", "MOCK_CLINIC"] } } },
      select: { event: { select: { kind: true } } },
    }),
    db.attendanceEvent.count({ where: { ...eventScope, kind: "MOCK_CLINIC" } }),
    db.training.findUnique({
      where: { personId_termId_track: { personId, termId, track } },
      select: { morningStatus: true, mockClinicMarkedAt: true, attempts: { where: { passed: true }, select: { id: true }, take: 1 } },
    }),
    db.course.findUnique({ where: { makeupForCycleId: cycle.id }, select: { id: true } }),
    isReturning(db, personId, cycle.id, termId, track),
  ]);

  const completedMakeupCourse = makeup
    ? (await db.courseProgress.count({
        where: { personId, courseId: makeup.id, termId, status: "COMPLETE" },
      })) > 0
    : false;

  return {
    cycleId: cycle.id,
    facts: {
      track,
      clinical: memberships.length > 0 && memberships.every((m) => m.department.isClinical),
      returning,
      attendedMorning: attendance.some((a) => a.event.kind === "TRAINING"),
      attendedMockClinic: attendance.some((a) => a.event.kind === "MOCK_CLINIC"),
      hasMockClinic: mockClinicEvents > 0,
      completedMakeupCourse,
      markedOff: row?.mockClinicMarkedAt != null,
      passedRetiredQuiz: row?.morningStatus === "QUIZ" || (row?.attempts.length ?? 0) > 0,
    },
  };
}

export type RecomputeResult = {
  parts: TrainingDayParts;
  complete: boolean;
  /** True when the rollup flipped (PENDING to COMPLETE or back). */
  changed: boolean;
} | null;

/** Recompute both parts and the rollup from the facts, and persist them.
 *  Idempotent. Call after anything that changes a fact: a check-in, a
 *  course completion, a mark-off, a promotion, a department change. Returns
 *  null (and writes nothing) when the term has no designated training cycle
 *  for the track. */
export async function recomputeTrainingStanding(
  db: Db,
  args: { personId: string; termId: string; track: Track }
): Promise<RecomputeResult> {
  const loaded = await loadTrainingDayFacts(db, args);
  if (!loaded) return null;
  const { cycleId, facts } = loaded;
  const { personId, termId, track } = args;

  const parts = trainingDayParts(facts);
  const complete = partsComplete(parts);

  const existing = await db.training.findUnique({
    where: { personId_termId_track: { personId, termId, track } },
    select: { status: true, completedAt: true, attendanceRecordedById: true, attendanceRecordedAt: true },
  });

  // Who recorded the morning, for the roster's "recorded by" line. Only a
  // morning that was attended has one.
  let recordedBy: { id: string | null; at: Date | null } = { id: null, at: null };
  if (parts.morning === "ATTENDED") {
    const first = await db.eventAttendance.findFirst({
      where: { personId, event: { termId, kind: "TRAINING", cycle: { track } } },
      orderBy: { checkedInAt: "asc" },
      select: { recordedById: true, checkedInAt: true },
    });
    recordedBy = { id: first?.recordedById ?? null, at: first?.checkedInAt ?? null };
  }

  const data = {
    morningStatus: parts.morning,
    mockClinicStatus: parts.mockClinic,
    status: complete ? ("COMPLETE" as const) : ("PENDING" as const),
    completedVia: complete ? completedViaFor(parts.morning) : null,
    // Keep the original completion instant across recomputes; a fresh one only
    // when it becomes complete.
    completedAt: complete ? (existing?.status === "COMPLETE" ? existing.completedAt : new Date()) : null,
    attendanceRecordedById: recordedBy.id,
    attendanceRecordedAt: recordedBy.at,
    ...(complete ? { locked: false } : {}),
  };

  await db.training.upsert({
    where: { personId_termId_track: { personId, termId, track } },
    create: { personId, termId, cycleId, track, ...data },
    update: data,
  });

  return { parts, complete, changed: (existing?.status === "COMPLETE") !== complete };
}

/** Recompute everyone the designated cycle's training concerns: every ACTIVE
 *  member of the track that term, plus anyone who already has a row (a walk-up
 *  credited before promotion). Sequential on purpose: a few hundred people,
 *  run from the reminders sweep and after a department's clinical flag moves,
 *  and never worth a connection-pool spike. */
export async function recomputeTrainingStandingForTerm(
  termId: string,
  track: Track
): Promise<{ people: number; nowComplete: number; nowPending: number }> {
  const cycle = await designatedCycle(prisma, termId, track);
  if (!cycle) return { people: 0, nowComplete: 0, nowPending: 0 };

  const [members, rows] = await Promise.all([
    prisma.termMembership.findMany({
      where: { termId, kind: track, status: "ACTIVE" },
      select: { personId: true },
      distinct: ["personId"],
    }),
    prisma.training.findMany({ where: { termId, track }, select: { personId: true } }),
  ]);
  const people = [...new Set([...members, ...rows].map((r) => r.personId))];

  let nowComplete = 0;
  let nowPending = 0;
  for (const personId of people) {
    const result = await recomputeTrainingStanding(prisma, { personId, termId, track });
    if (result?.changed) {
      if (result.complete) nowComplete += 1;
      else nowPending += 1;
    }
  }
  return { people: people.length, nowComplete, nowPending };
}

/** Recompute the members of one department in every live or upcoming term,
 *  after its clinical flag moved. */
export async function recomputeTrainingStandingForDepartment(departmentId: string): Promise<void> {
  const memberships = await prisma.termMembership.findMany({
    where: { departmentId, status: "ACTIVE", term: { status: { in: ["ACTIVE", "PLANNING"] } } },
    select: { personId: true, termId: true, kind: true },
  });
  for (const m of memberships) {
    await recomputeTrainingStanding(prisma, { personId: m.personId, termId: m.termId, track: m.kind });
  }
}

/** Recompute every term that has a designated training cycle and is live or
 *  upcoming. The reminders sweep calls this so a fact that changed without a
 *  recompute of its own (a membership moved department, a department's
 *  clinical flag flipped) cannot leave someone's standing stale for long. */
export async function recomputeCurrentTrainingStanding(): Promise<{ people: number; nowComplete: number; nowPending: number }> {
  const cycles = await prisma.recruitmentCycle.findMany({
    where: { isTermTraining: true, term: { status: { in: ["ACTIVE", "PLANNING"] } } },
    select: { termId: true, track: true },
  });
  const total = { people: 0, nowComplete: 0, nowPending: 0 };
  for (const c of cycles) {
    const r = await recomputeTrainingStandingForTerm(c.termId, c.track);
    total.people += r.people;
    total.nowComplete += r.nowComplete;
    total.nowPending += r.nowPending;
  }
  return total;
}

/** Where a person stands on a training cycle's online makeup course. */
export type MakeupAccess = {
  /** OWED: their morning is owed, so the course is theirs to take.
   *  DONE: they finished it (morningStatus ONLINE_COURSE).
   *  NOT_OWED: anything else (attended, clinical, not a member). */
  status: "OWED" | "DONE" | "NOT_OWED";
  /** The cycle's term: makeup progress is recorded against it, never against
   *  the active term, so a returning member can finish before the switch. */
  termId: string;
  track: Track;
  /** 3 failed tries on a section quiz lock the makeup, exactly like the retired
   *  quiz did; a director clears it with the training roster's Reset. */
  locked: boolean;
  /** Only attempts at or after this instant count toward the lock. */
  lockResetAt: Date | null;
};

/** Where `personId` stands on `cycleId`'s makeup course. */
export async function getMakeupAccess(personId: string, cycleId: string): Promise<MakeupAccess> {
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id: cycleId },
    select: { termId: true, track: true },
  });
  if (!cycle) return { status: "NOT_OWED", termId: "", track: "VOLUNTEER", locked: false, lockResetAt: null };
  const { termId, track } = cycle;
  const key = { personId_termId_track: { personId, termId, track } };

  const [isMember, initial] = await Promise.all([
    prisma.termMembership.count({ where: { personId, termId, kind: track, status: "ACTIVE" } }),
    prisma.training.findUnique({ where: key }),
  ]);
  let row = initial;
  if (!row && isMember > 0) {
    // Nothing has computed their standing yet (promoted before this shipped,
    // and the sweep has not run). Compute it now rather than guess.
    await recomputeTrainingStanding(prisma, { personId, termId, track });
    row = await prisma.training.findUnique({ where: key });
  }

  const status: MakeupAccess["status"] =
    row?.morningStatus === "ONLINE_COURSE"
      ? "DONE"
      : row?.morningStatus === "OWED" && isMember > 0
        ? "OWED"
        : "NOT_OWED";
  return { status, termId, track, locked: row?.locked ?? false, lockResetAt: row?.lockResetAt ?? null };
}

/** Lock the person's makeup after the last allowed failed attempt. The
 *  training roster's Reset (resetTraining) clears it and stamps lockResetAt. */
export async function lockMakeup(db: Db, personId: string, cycleId: string): Promise<void> {
  const cycle = await db.recruitmentCycle.findUnique({
    where: { id: cycleId },
    select: { termId: true, track: true },
  });
  if (!cycle) return;
  await db.training.upsert({
    where: { personId_termId_track: { personId, termId: cycle.termId, track: cycle.track } },
    create: { personId, termId: cycle.termId, cycleId, track: cycle.track, locked: true },
    update: { locked: true },
  });
}
