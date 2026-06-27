import type { RecruitmentCycle, Prisma, TrainingMethod, TrainingTrack } from "@prisma/client";
import { complianceStatus, overallClearance } from "@/platform/compliance/rules";
import type { TrainingState, OverallClearance } from "@/platform/compliance/rules";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { getActiveTerm } from "@/platform/terms/active-term";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError, reviewScope } from "./review";
import { gradeQuiz, type GradedQuestion } from "@/platform/quiz/grading";

export class TrainingStateError extends Error {
  constructor(message: string) { super(message); this.name = "TrainingStateError"; }
}
export class QuizLockedError extends Error {
  constructor(message: string) { super(message); this.name = "QuizLockedError"; }
}

export type QuizResultPublic = { score: number; total: number; percent: number; passed: boolean };

/** What submitQuiz returns: the score plus everything the page needs to render
 *  in-place review (which option was correct), the live attempt count, and
 *  whether this attempt tripped the lockout. */
export type QuizSubmission = QuizResultPublic & {
  attemptsUsed: number;
  locked: boolean;
  /** Graded question key -> correct option value, for correct/wrong highlighting. */
  correctByKey: Record<string, string>;
};

/** The term's designated training cycle for a track, or null. */
export async function getTrainingCycleForTerm(termId: string, track: TrainingTrack): Promise<RecruitmentCycle | null> {
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
  await prisma.$transaction(async (tx) => {
    if (value) {
      await tx.recruitmentCycle.updateMany({ where: { termId: cycle.termId, track: cycle.track, isTermTraining: true, NOT: { id: cycleId } }, data: { isTermTraining: false } });
    }
    await tx.recruitmentCycle.update({ where: { id: cycleId }, data: { isTermTraining: value } });
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_designate", entityType: "RecruitmentCycle", entityId: cycleId, after: { isTermTraining: value } });
}

/** Update the cycle's quiz threshold and attempt cap. Requires manage_cycles. */
export async function updateQuizSettings(
  cycleId: string,
  input: { quizPassPercent: number; quizMaxAttempts: number },
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
  const updated = await prisma.recruitmentCycle.update({ where: { id: cycleId }, data: { quizPassPercent: input.quizPassPercent, quizMaxAttempts: input.quizMaxAttempts } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_quiz_settings", entityType: "RecruitmentCycle", entityId: cycleId, after: input });
  return updated;
}

type Tx = Prisma.TransactionClient;

/** PENDING unless the person has a COMPLETE Training row for the term and track. */
export async function resolveTrainingState(personId: string, termId: string, track: TrainingTrack): Promise<TrainingState> {
  const row = await prisma.training.findUnique({ where: { personId_termId_track: { personId, termId, track } } });
  return row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";
}

/** The training tracks a person must complete this term: a track is required when
 *  the person holds an active membership of that kind AND the term has a designated
 *  training cycle for that track. Generalizes the volunteer-only check. */
export async function requiredTrainingTracks(personId: string, termId: string): Promise<TrainingTrack[]> {
  const pairs: [TrainingTrack, "VOLUNTEER" | "DIRECTOR"][] = [["VOLUNTEER", "VOLUNTEER"], ["DIRECTOR", "DIRECTOR"]];
  const result: TrainingTrack[] = [];
  for (const [track, kind] of pairs) {
    const hasMembership = await prisma.termMembership.count({ where: { personId, termId, kind, status: "ACTIVE" } });
    if (hasMembership === 0) continue;
    if (await getTrainingCycleForTerm(termId, track)) result.push(track);
  }
  return result;
}

/** Upsert the person's training row to COMPLETE for the term and track, stamping the method.
 *  Shared by the attendance and quiz paths. Idempotent. */
export async function completeTraining(
  db: Tx | typeof prisma,
  args: { personId: string; termId: string; cycleId: string; track: TrainingTrack; via: TrainingMethod; actorId?: string }
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
export async function recordAttendance(personId: string, termId: string, track: TrainingTrack, actorId: string): Promise<void> {
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

/** Active term used for self-serve training (mirrors compliance: newest ACTIVE term). */
async function activeTermOrThrow() {
  const term = await getActiveTerm();
  if (!term) throw new TrainingStateError("No active term.");
  return term;
}

/** The designated cycle's graded quiz questions, in form order. */
async function quizQuestions(cycleId: string): Promise<GradedQuestion[]> {
  const fields = await prisma.formField.findMany({
    where: { cycleId, type: "SINGLE_SELECT", section: { purpose: "QUIZ" } },
    orderBy: [{ section: { order: "asc" } }, { order: "asc" }],
    select: { key: true, correctValue: true },
  });
  return fields.map((f) => ({ key: f.key, correctValue: f.correctValue }));
}

export type MyTraining = {
  track: TrainingTrack;
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
  questions: { key: string; label: string; options: { value: string; label: string }[] }[];
  intake: TrainingIntake;
};

const TRACK_LABEL: Record<TrainingTrack, string> = {
  VOLUNTEER: "Volunteer training",
  DIRECTOR: "Director training",
};

/** The training(s) the signed-in member must complete this term, one per required track. */
export async function getMyTraining(personId: string): Promise<MyTraining[]> {
  const term = await activeTermOrThrow();
  const tracks = await requiredTrainingTracks(personId, term.id);
  const out: MyTraining[] = [];
  for (const track of tracks) {
    const cycle = await getTrainingCycleForTerm(term.id, track);
    const row = await prisma.training.findUnique({ where: { personId_termId_track: { personId, termId: term.id, track } } });
    const state: TrainingState = row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";

    let questions: MyTraining["questions"] = [];
    if (cycle) {
      const fields = await prisma.formField.findMany({
        where: { cycleId: cycle.id, type: "SINGLE_SELECT", section: { purpose: "QUIZ" } },
        orderBy: [{ section: { order: "asc" } }, { order: "asc" }],
        select: { key: true, label: true, options: true },
      });
      questions = fields.map((f) => ({ key: f.key, label: f.label, options: (f.options as { value: string; label: string }[] | null) ?? [] }));
    }

    const attemptsUsed = row ? await prisma.quizAttempt.count({ where: { trainingId: row.id, ...(row.lockResetAt ? { takenAt: { gte: row.lockResetAt } } : {}) } }) : 0;

    out.push({
      track, trackLabel: TRACK_LABEL[track],
      term: { id: term.id, name: term.name },
      cycle: cycle ? { id: cycle.id, title: cycle.title } : null,
      state, locked: row?.locked ?? false, completedVia: row?.completedVia ?? null, completedAt: row?.completedAt ?? null,
      attemptsUsed, maxAttempts: cycle?.quizMaxAttempts ?? 0, passPercent: cycle?.quizPassPercent ?? 0,
      questions,
      intake: {
        additionalShiftAvailability: row?.additionalShiftAvailability ?? null,
        minShiftsWanted: row?.minShiftsWanted ?? null,
        feedback: row?.feedback ?? null,
      },
    });
  }
  return out;
}

/** Grade and persist a quiz attempt for the signed-in member. Lazily creates
 *  the training row. Saves intake. On pass: completes training. On reaching the
 *  attempt cap without a pass: locks. Prior attempts are never deleted. */
export async function submitQuiz(
  personId: string,
  input: { track: TrainingTrack; answers: Record<string, unknown>; intake: TrainingIntake }
): Promise<QuizSubmission> {
  const term = await activeTermOrThrow();
  const cycle = await getTrainingCycleForTerm(term.id, input.track);
  if (!cycle) throw new TrainingStateError("This term has no designated training cycle.");

  const isMember = await prisma.termMembership.count({ where: { personId, termId: term.id, kind: input.track, status: "ACTIVE" } });
  if (isMember === 0) throw new TrainingStateError("Not an active member of this track this term.");

  const questions = await quizQuestions(cycle.id);
  if (questions.length === 0) throw new TrainingStateError("This training has no quiz questions yet.");

  return prisma.$transaction(async (tx) => {
    const row = await tx.training.upsert({
      where: { personId_termId_track: { personId, termId: term.id, track: input.track } },
      create: { personId, termId: term.id, cycleId: cycle.id, track: input.track },
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
      await completeTraining(tx, { personId, termId: term.id, cycleId: cycle.id, track: input.track, via: "QUIZ" });
    } else if (attemptsUsed >= cycle.quizMaxAttempts) {
      await tx.training.update({ where: { id: row.id }, data: { locked: true } });
      locked = true;
    }

    const correctByKey = Object.fromEntries(
      questions.filter((q) => q.correctValue !== null).map((q) => [q.key, q.correctValue as string])
    );
    return { score: result.score, total: result.total, percent: result.percent, passed: result.passed, attemptsUsed, locked, correctByKey };
  });
}

/** Clear a locked member so they can retake the quiz. Opens a fresh attempt
 *  window (lockResetAt = now); prior attempts stay in history. Director-scoped or
 *  review_all. */
export async function resetTraining(personId: string, termId: string, track: TrainingTrack, actorId: string): Promise<void> {
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
    const certStatus = complianceStatus(cert ? { completionDate: cert.completionDate } : null, term.endDate);
    const row = training.get(m.person.id);
    const trainingState: TrainingState = row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";
    return {
      personId: m.person.id, name: m.person.name, departmentCode: m.department.code,
      certStatus, trainingState, locked: row?.locked ?? false,
      overallClearance: overallClearance(certStatus, trainingState === "COMPLETE"),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
