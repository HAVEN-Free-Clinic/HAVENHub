import type { RecruitmentCycle, Prisma, TrainingMethod, Track } from "@prisma/client";
import { complianceStatus, overallClearance } from "@/platform/compliance/rules";
import type { TrainingState, OverallClearance } from "@/platform/compliance/rules";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { getPersonTerms } from "@/platform/terms/person-terms";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError, reviewScope } from "./review";
import { gradeQuiz, type GradedQuestion } from "@/platform/quiz/grading";
import { countGradedQuestions } from "@/platform/quiz/graded";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { makeupIsOpen } from "./makeup-window";

export class TrainingStateError extends Error {
  constructor(message: string) { super(message); this.name = "TrainingStateError"; }
}
export class QuizLockedError extends Error {
  constructor(message: string) { super(message); this.name = "QuizLockedError"; }
}

export type QuizResultPublic = { score: number; total: number; percent: number; passed: boolean };

/** What submitQuiz returns: the score plus everything the page needs to render
 *  in-place review (whether each answer was right, never the answer itself), the
 *  live attempt count, and whether this attempt tripped the lockout. */
export type QuizSubmission = QuizResultPublic & {
  attemptsUsed: number;
  locked: boolean;
  /** Graded question key -> whether the learner's answer was right. Ungraded
   *  questions (correctValue == null) are absent, so the review screen leaves
   *  them unmarked rather than implying they were scored. Never carries the
   *  correct value itself: a failed attempt precedes a retry. */
  verdictByKey: Record<string, "correct" | "wrong">;
};

/** The term's designated training cycle for a track, or null. */
export async function getTrainingCycleForTerm(termId: string, track: Track): Promise<RecruitmentCycle | null> {
  return prisma.recruitmentCycle.findFirst({ where: { termId, track, isTermTraining: true } });
}

/** Mark a cycle as the term's training source (or clear it). Designating one
 *  clears any other of the same track in the same term inside a transaction,
 *  preserving the one-per-term-per-track invariant. Requires manage_cycles. */
export async function setTrainingCycle(cycleId: string, value: boolean, actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new RecruitmentAuthError("Only recruitment leads can set the training cycle.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new TrainingStateError("Cycle not found.");
  if (value && countGradedQuestions(await quizQuestions(cycleId)) === 0) {
    throw new TrainingStateError(
      "This cycle's quiz has no answer keys, so nobody could pass it. Add questions with a correct answer on the cycle's Quiz tab first."
    );
  }
  await prisma.$transaction(async (tx) => {
    if (value) {
      await tx.recruitmentCycle.updateMany({ where: { termId: cycle.termId, track: cycle.track, isTermTraining: true, NOT: { id: cycleId } }, data: { isTermTraining: false } });
    }
    await tx.recruitmentCycle.update({ where: { id: cycleId }, data: { isTermTraining: value } });
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_designate", entityType: "RecruitmentCycle", entityId: cycleId, after: { isTermTraining: value } });
}

/** Update the cycle's quiz threshold, attempt cap, in-person training date, and
 *  training location/time text. Requires manage_cycles. */
export async function updateQuizSettings(
  cycleId: string,
  input: {
    quizPassPercent: number;
    quizMaxAttempts: number;
    inPersonTrainingDate: Date | null;
    trainingLocation: string | null;
  },
  actorId: string
): Promise<RecruitmentCycle> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new RecruitmentAuthError("Only recruitment leads can change quiz settings.");
  }
  if (!Number.isInteger(input.quizPassPercent) || input.quizPassPercent < 0 || input.quizPassPercent > 100) {
    throw new TrainingStateError("Pass percent must be between 0 and 100.");
  }
  if (!Number.isInteger(input.quizMaxAttempts) || input.quizMaxAttempts < 1) {
    throw new TrainingStateError("Max attempts must be at least 1.");
  }
  // Normalize here, not just in the UI action, so a direct/internal caller
  // cannot store a whitespace-only location and the audit log stays consistent.
  const trainingLocation = input.trainingLocation?.trim() || null;
  const updated = await prisma.recruitmentCycle.update({
    where: { id: cycleId },
    data: {
      quizPassPercent: input.quizPassPercent,
      quizMaxAttempts: input.quizMaxAttempts,
      inPersonTrainingDate: input.inPersonTrainingDate,
      trainingLocation,
    },
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_quiz_settings", entityType: "RecruitmentCycle", entityId: cycleId, after: { ...input, trainingLocation } });
  return updated;
}

type Tx = Prisma.TransactionClient;

/** PENDING unless the person has a COMPLETE Training row for the term and track. */
export async function resolveTrainingState(personId: string, termId: string, track: Track): Promise<TrainingState> {
  const row = await prisma.training.findUnique({ where: { personId_termId_track: { personId, termId, track } } });
  return row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";
}

/** Training state plus attempts used in the current window (after any lock reset).
 *  The onboarding checklist needs the attempt count to distinguish IN_PROGRESS
 *  (a quiz was attempted but not passed) from INCOMPLETE (never started). */
export async function resolveTrainingProgress(
  personId: string,
  termId: string,
  track: Track
): Promise<{ state: TrainingState; attemptsUsed: number }> {
  const row = await prisma.training.findUnique({ where: { personId_termId_track: { personId, termId, track } } });
  const state: TrainingState = row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";
  const attemptsUsed = row
    ? await prisma.quizAttempt.count({
        where: { trainingId: row.id, ...(row.lockResetAt ? { takenAt: { gte: row.lockResetAt } } : {}) },
      })
    : 0;
  return { state, attemptsUsed };
}

/** The training tracks a person must complete this term: a track is required when
 *  the person holds an active membership of that kind AND the term has a designated
 *  training cycle for that track. Generalizes the volunteer-only check. */
export async function requiredTrainingTracks(personId: string, termId: string): Promise<Track[]> {
  const pairs: [Track, "VOLUNTEER" | "DIRECTOR"][] = [["VOLUNTEER", "VOLUNTEER"], ["DIRECTOR", "DIRECTOR"]];
  const tracks = pairs.map(([track]) => track);
  const kinds = pairs.map(([, kind]) => kind);
  // Two parallel reads instead of a per-track count+lookup loop: the person's active
  // memberships and the term's designated training cycles, intersected in memory.
  // isTermTraining mirrors getTrainingCycleForTerm's designated-cycle filter.
  const [memberships, cycles] = await Promise.all([
    prisma.termMembership.findMany({
      where: { personId, termId, status: "ACTIVE", kind: { in: kinds } },
      select: { kind: true },
    }),
    prisma.recruitmentCycle.findMany({
      where: { termId, track: { in: tracks }, isTermTraining: true },
      select: { track: true },
    }),
  ]);
  const activeKinds = new Set(memberships.map((m) => m.kind));
  const designatedTracks = new Set(cycles.map((c) => c.track));
  return pairs
    .filter(([track, kind]) => activeKinds.has(kind) && designatedTracks.has(track))
    .map(([track]) => track);
}

/** Upsert the person's training row to COMPLETE for the term and track, stamping the method.
 *  Shared by the attendance and quiz paths. Idempotent. */
export async function completeTraining(
  db: Tx | typeof prisma,
  args: { personId: string; termId: string; cycleId: string; track: Track; via: TrainingMethod; actorId?: string }
): Promise<void> {
  const now = new Date();
  const attendance = args.via === "ATTENDANCE";
  await db.training.upsert({
    where: { personId_termId_track: { personId: args.personId, termId: args.termId, track: args.track } },
    create: {
      personId: args.personId, termId: args.termId, cycleId: args.cycleId, track: args.track,
      status: "COMPLETE", completedVia: args.via, completedAt: now,
      attendanceRecordedById: attendance ? (args.actorId ?? null) : null,
      attendanceRecordedAt: attendance ? now : null,
    },
    update: {
      status: "COMPLETE", completedVia: args.via, completedAt: now, locked: false,
      ...(attendance ? { attendanceRecordedById: args.actorId ?? null, attendanceRecordedAt: now } : {}),
    },
  });
}

/** Record live-session attendance for a member (by personId) in the term and track.
 *  Director-scoped (the member must be in a department the actor manages) or
 *  review_all. Completes via ATTENDANCE. */
export async function recordAttendance(personId: string, termId: string, track: Track, actorId: string): Promise<void> {
  const cycle = await getTrainingCycleForTerm(termId, track);
  if (!cycle) throw new TrainingStateError("This term has no designated training cycle.");

  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId, kind: track, status: "ACTIVE" },
    include: { department: { select: { code: true } } },
  });
  if (memberships.length === 0) throw new TrainingStateError("Not an active member of this track this term.");

  const scope = await reviewScope(actorId);
  const inScope = scope.all || memberships.some((m) => scope.departmentCodes.includes(m.department.code));
  if (!inScope) throw new RecruitmentAuthError("You can't record training for that member.");

  await completeTraining(prisma, { personId, termId, cycleId: cycle.id, track, via: "ATTENDANCE", actorId });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_attendance", entityType: "Training", entityId: `${personId}:${termId}:${track}`, after: { personId, termId, track } });
}

export type TrainingIntake = {
  additionalShiftAvailability?: string | null;
  minShiftsWanted?: string | null;
  feedback?: string | null;
};

/** Grading-only quiz question fetch, in form order.
 *  Returns only `key` and `correctValue` for answer checking.
 *  Do not use this for rendering; display flows (for example `getMyTrainingForTerm`)
 *  must fetch question `label` and `options` separately. */
async function quizQuestions(cycleId: string): Promise<GradedQuestion[]> {
  const fields = await prisma.formField.findMany({
    where: { cycleId, type: "SINGLE_SELECT", section: { purpose: "QUIZ" } },
    orderBy: [{ section: { order: "asc" } }, { order: "asc" }],
    select: { key: true, correctValue: true },
  });
  return fields.map((f) => ({ key: f.key, correctValue: f.correctValue }));
}

export type MyTraining = {
  track: Track;
  trackLabel: string;
  term: { id: string; name: string };
  cycle: { id: string; title: string } | null;
  state: TrainingState;
  locked: boolean;
  completedVia: TrainingMethod | null;
  completedAt: Date | null;
  attemptsUsed: number;
  maxAttempts: number;
  passPercent: number;
  inPersonTrainingDate: Date | null;
  makeupOpen: boolean;
  questions: { key: string; label: string; options: { value: string; label: string }[] }[];
  /** How many of the cycle's quiz questions carry an answer key (see
   *  countGradedQuestions). Zero means the quiz cannot be passed no matter how
   *  many questions render, so the page must treat it the same as "no quiz". */
  gradedQuestionCount: number;
  intake: TrainingIntake;
};

const TRACK_LABEL: Record<Track, string> = {
  VOLUNTEER: "Volunteer training",
  DIRECTOR: "Director training",
};

/** The required training(s) for one specific term, one entry per required track. */
export async function getMyTrainingForTerm(personId: string, term: { id: string; name: string }): Promise<MyTraining[]> {
  const tracks = await requiredTrainingTracks(personId, term.id);
  const zone = await getDisplayTimeZone();
  const now = new Date();
  // Fan the tracks out rather than awaiting each in series; within a track the
  // cycle and training row are independent, so fetch them together too.
  return Promise.all(
    tracks.map(async (track) => {
      const [cycle, row] = await Promise.all([
        getTrainingCycleForTerm(term.id, track),
        prisma.training.findUnique({ where: { personId_termId_track: { personId, termId: term.id, track } } }),
      ]);
      const state: TrainingState = row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";

      let questions: MyTraining["questions"] = [];
      let gradedQuestionCount = 0;
      if (cycle) {
        const fields = await prisma.formField.findMany({
          where: { cycleId: cycle.id, type: "SINGLE_SELECT", section: { purpose: "QUIZ" } },
          orderBy: [{ section: { order: "asc" } }, { order: "asc" }],
          select: { key: true, label: true, options: true, correctValue: true },
        });
        gradedQuestionCount = countGradedQuestions(fields);
        // Build questions without correctValue: this array is passed straight to a
        // client component, so the answer key must never ride along.
        questions = fields.map((f) => ({ key: f.key, label: f.label, options: (f.options as { value: string; label: string }[] | null) ?? [] }));
      }

      const attemptsUsed = row ? await prisma.quizAttempt.count({ where: { trainingId: row.id, ...(row.lockResetAt ? { takenAt: { gte: row.lockResetAt } } : {}) } }) : 0;

      return {
        track, trackLabel: TRACK_LABEL[track],
        term: { id: term.id, name: term.name },
        cycle: cycle ? { id: cycle.id, title: cycle.title } : null,
        state, locked: row?.locked ?? false, completedVia: row?.completedVia ?? null, completedAt: row?.completedAt ?? null,
        attemptsUsed, maxAttempts: cycle?.quizMaxAttempts ?? 0, passPercent: cycle?.quizPassPercent ?? 0,
        inPersonTrainingDate: cycle?.inPersonTrainingDate ?? null,
        makeupOpen: makeupIsOpen(cycle?.inPersonTrainingDate ?? null, now, zone),
        questions,
        gradedQuestionCount,
        intake: {
          additionalShiftAvailability: row?.additionalShiftAvailability ?? null,
          minShiftsWanted: row?.minShiftsWanted ?? null,
          feedback: row?.feedback ?? null,
        },
      };
    }),
  );
}

/** The training(s) the signed-in member must complete across every term they belong to. */
export async function getMyTraining(personId: string): Promise<MyTraining[]> {
  const terms = await getPersonTerms(personId);
  const out: MyTraining[] = [];
  for (const term of terms) {
    out.push(...(await getMyTrainingForTerm(personId, term)));
  }
  return out;
}

/** Grade and persist a quiz attempt for the signed-in member. Lazily creates
 *  the training row. Saves intake. On pass: completes training. On reaching the
 *  attempt cap without a pass: locks. Prior attempts are never deleted. */
export async function submitQuiz(
  personId: string,
  input: { termId: string; track: Track; answers: Record<string, unknown>; intake: TrainingIntake }
): Promise<QuizSubmission> {
  const cycle = await getTrainingCycleForTerm(input.termId, input.track);
  if (!cycle) throw new TrainingStateError("This term has no designated training cycle.");

  const isMember = await prisma.termMembership.count({ where: { personId, termId: input.termId, kind: input.track, status: "ACTIVE" } });
  if (isMember === 0) throw new TrainingStateError("Not an active member of this track this term.");

  const zone = await getDisplayTimeZone();
  if (!makeupIsOpen(cycle.inPersonTrainingDate, new Date(), zone)) {
    throw new TrainingStateError("The makeup quiz isn't open yet.");
  }

  const questions = await quizQuestions(cycle.id);
  if (countGradedQuestions(questions) === 0) {
    throw new TrainingStateError("This training's quiz is not ready yet. Contact your coordinator.");
  }

  return prisma.$transaction(async (tx) => {
    const row = await tx.training.upsert({
      where: { personId_termId_track: { personId, termId: input.termId, track: input.track } },
      create: { personId, termId: input.termId, cycleId: cycle.id, track: input.track },
      update: {},
    });
    if (row.status === "COMPLETE") throw new TrainingStateError("Training is already complete.");
    if (row.locked) throw new QuizLockedError("Your quiz is locked. Ask your director to reset it.");

    await tx.training.update({
      where: { id: row.id },
      data: {
        additionalShiftAvailability: input.intake.additionalShiftAvailability ?? undefined,
        minShiftsWanted: input.intake.minShiftsWanted ?? undefined,
        feedback: input.intake.feedback ?? undefined,
      },
    });

    const result = gradeQuiz(questions, input.answers, cycle.quizPassPercent);
    await tx.quizAttempt.create({ data: { trainingId: row.id, answers: input.answers as object, score: result.score, total: result.total, passed: result.passed } });

    // Attempts used in the current window (after any reset), incl. this one.
    const attemptsUsed = await tx.quizAttempt.count({ where: { trainingId: row.id, ...(row.lockResetAt ? { takenAt: { gte: row.lockResetAt } } : {}) } });
    let locked = false;
    if (result.passed) {
      await completeTraining(tx, { personId, termId: input.termId, cycleId: cycle.id, track: input.track, via: "QUIZ" });
    } else if (attemptsUsed >= cycle.quizMaxAttempts) {
      await tx.training.update({ where: { id: row.id }, data: { locked: true } });
      locked = true;
    }

    const verdictByKey = Object.fromEntries(
      questions
        .filter((q) => q.correctValue !== null)
        .map((q) => [q.key, input.answers[q.key] === q.correctValue ? "correct" : "wrong"] as const)
    );
    return { score: result.score, total: result.total, percent: result.percent, passed: result.passed, attemptsUsed, locked, verdictByKey };
  });
}

/** Clear a locked member so they can retake the quiz. Opens a fresh attempt
 *  window (lockResetAt = now); prior attempts stay in history. Director-scoped or
 *  review_all. */
export async function resetTraining(personId: string, termId: string, track: Track, actorId: string): Promise<void> {
  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId, kind: track, status: "ACTIVE" },
    include: { department: { select: { code: true } } },
  });
  if (memberships.length === 0) throw new TrainingStateError("Not an active member of this track this term.");
  const scope = await reviewScope(actorId);
  const inScope = scope.all || memberships.some((m) => scope.departmentCodes.includes(m.department.code));
  if (!inScope) throw new RecruitmentAuthError("You can't reset training for that member.");

  await prisma.training.updateMany({ where: { personId, termId, track, status: { not: "COMPLETE" } }, data: { locked: false, lockResetAt: new Date() } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_reset", entityType: "Training", entityId: `${personId}:${termId}:${track}` });
}

export type TrainingRosterRow = {
  personId: string;
  name: string;
  departmentCode: string;
  certStatus: ReturnType<typeof complianceStatus>;
  trainingState: TrainingState;
  locked: boolean;
  overallClearance: OverallClearance;
};

/** The designated cycle's training roster: in-scope active memberships of the cycle's track
 *  in the cycle's term, each with cert status and training state. Director-scoped
 *  or review_all. Throws TrainingStateError if the cycle is not the designated
 *  training cycle for its term. */
export async function listTrainingRoster(cycleId: string, viewerId: string): Promise<TrainingRosterRow[]> {
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new TrainingStateError("Cycle not found.");
  if (!cycle.isTermTraining) throw new TrainingStateError("This cycle is not the term's training cycle.");

  const term = await prisma.term.findUniqueOrThrow({ where: { id: cycle.termId } });
  const scope = await reviewScope(viewerId);

  const memberships = await prisma.termMembership.findMany({
    where: {
      termId: cycle.termId, kind: cycle.track, status: "ACTIVE",
      ...(scope.all ? {} : { department: { code: { in: scope.departmentCodes } } }),
    },
    include: {
      department: { select: { code: true } },
      person: { select: { id: true, name: true, hipaaCertificates: { orderBy: { uploadedAt: "desc" }, take: 1 } } },
    },
  });

  const personIds = memberships.map((m) => m.person.id);
  const training = new Map(
    (await prisma.training.findMany({ where: { termId: cycle.termId, track: cycle.track, personId: { in: personIds } } })).map((t) => [t.personId, t])
  );

  return memberships.map((m) => {
    const cert = m.person.hipaaCertificates[0] ?? null;
    const certStatus = complianceStatus(cert ? { completionDate: cert.completionDate, verifiedAt: cert.verifiedAt } : null, term.endDate);
    const row = training.get(m.person.id);
    const trainingState: TrainingState = row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";
    return {
      personId: m.person.id, name: m.person.name, departmentCode: m.department.code,
      certStatus, trainingState, locked: row?.locked ?? false,
      overallClearance: overallClearance(certStatus, trainingState === "COMPLETE"),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
