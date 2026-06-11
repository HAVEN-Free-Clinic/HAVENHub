import type { RecruitmentCycle, Prisma, TrainingMethod } from "@prisma/client";
import { complianceStatus, overallClearance } from "@/platform/compliance/rules";
import type { TrainingState, OverallClearance } from "@/platform/compliance/rules";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
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

/** The term's designated training cycle, or null. */
export async function getTrainingCycleForTerm(termId: string): Promise<RecruitmentCycle | null> {
  return prisma.recruitmentCycle.findFirst({ where: { termId, isTermTraining: true } });
}

/** Mark a cycle as the term's training source (or clear it). Designating one
 *  clears any other in the same term inside a transaction, preserving the
 *  one-per-term invariant. Requires manage_cycles. */
export async function setTrainingCycle(cycleId: string, value: boolean, actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new RecruitmentAuthError("Only recruitment leads can set the training cycle.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new TrainingStateError("Cycle not found.");
  if (cycle.track !== "VOLUNTEER") throw new TrainingStateError("Only a volunteer cycle can host training.");
  await prisma.$transaction(async (tx) => {
    if (value) {
      await tx.recruitmentCycle.updateMany({ where: { termId: cycle.termId, isTermTraining: true, NOT: { id: cycleId } }, data: { isTermTraining: false } });
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

/** PENDING unless the person has a COMPLETE VolunteerTraining row for the term. */
export async function resolveTrainingState(personId: string, termId: string): Promise<TrainingState> {
  const row = await prisma.volunteerTraining.findUnique({ where: { personId_termId: { personId, termId } } });
  return row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";
}

/** Upsert the person's training row to COMPLETE for the term, stamping the method.
 *  Shared by the attendance and quiz paths. Idempotent. */
export async function completeTraining(
  db: Tx | typeof prisma,
  args: { personId: string; termId: string; cycleId: string; via: TrainingMethod; actorId?: string }
): Promise<void> {
  const now = new Date();
  const attendance = args.via === "ATTENDANCE";
  await db.volunteerTraining.upsert({
    where: { personId_termId: { personId: args.personId, termId: args.termId } },
    create: {
      personId: args.personId, termId: args.termId, cycleId: args.cycleId,
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

/** Record live-session attendance for a volunteer (by personId) in the term.
 *  Director-scoped (the volunteer must be in a department the actor manages) or
 *  review_all. Completes via ATTENDANCE. */
export async function recordAttendance(personId: string, termId: string, actorId: string): Promise<void> {
  const cycle = await getTrainingCycleForTerm(termId);
  if (!cycle) throw new TrainingStateError("This term has no designated training cycle.");

  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId, kind: "VOLUNTEER", status: "ACTIVE" },
    include: { department: { select: { code: true } } },
  });
  if (memberships.length === 0) throw new TrainingStateError("Not an active volunteer this term.");

  const scope = await reviewScope(actorId);
  const inScope = scope.all || memberships.some((m) => scope.departmentCodes.includes(m.department.code));
  if (!inScope) throw new RecruitmentAuthError("You can't record training for that volunteer.");

  await completeTraining(prisma, { personId, termId, cycleId: cycle.id, via: "ATTENDANCE", actorId });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_attendance", entityType: "VolunteerTraining", entityId: `${personId}:${termId}`, after: { personId, termId } });
}

export type TrainingIntake = {
  subcommitteeInterest?: string | null;
  additionalShiftAvailability?: string | null;
  minShiftsWanted?: string | null;
  feedback?: string | null;
};

/** Active term used for self-serve training (mirrors compliance: newest ACTIVE term). */
async function activeTermOrThrow() {
  const term = await prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } });
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

/** Everything the volunteer's /training page needs. */
export async function getMyTraining(personId: string): Promise<MyTraining> {
  const term = await activeTermOrThrow();
  const cycle = await getTrainingCycleForTerm(term.id);
  const row = await prisma.volunteerTraining.findUnique({ where: { personId_termId: { personId, termId: term.id } } });
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

  return {
    term: { id: term.id, name: term.name },
    cycle: cycle ? { id: cycle.id, title: cycle.title } : null,
    state, locked: row?.locked ?? false, completedVia: row?.completedVia ?? null, completedAt: row?.completedAt ?? null,
    attemptsUsed, maxAttempts: cycle?.quizMaxAttempts ?? 0, passPercent: cycle?.quizPassPercent ?? 0,
    questions,
    intake: {
      subcommitteeInterest: row?.subcommitteeInterest ?? null,
      additionalShiftAvailability: row?.additionalShiftAvailability ?? null,
      minShiftsWanted: row?.minShiftsWanted ?? null,
      feedback: row?.feedback ?? null,
    },
  };
}

/** Grade and persist a quiz attempt for the signed-in volunteer. Lazily creates
 *  the training row. Saves intake. On pass: completes training. On reaching the
 *  attempt cap without a pass: locks. Prior attempts are never deleted. */
export async function submitQuiz(
  personId: string,
  input: { answers: Record<string, unknown>; intake: TrainingIntake }
): Promise<QuizSubmission> {
  const term = await activeTermOrThrow();
  const cycle = await getTrainingCycleForTerm(term.id);
  if (!cycle) throw new TrainingStateError("This term has no designated training cycle.");

  const isVolunteer = await prisma.termMembership.count({ where: { personId, termId: term.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  if (isVolunteer === 0) throw new TrainingStateError("Not an active volunteer this term.");

  const questions = await quizQuestions(cycle.id);
  if (questions.length === 0) throw new TrainingStateError("This training has no quiz questions yet.");

  return prisma.$transaction(async (tx) => {
    const row = await tx.volunteerTraining.upsert({
      where: { personId_termId: { personId, termId: term.id } },
      create: { personId, termId: term.id, cycleId: cycle.id },
      update: {},
    });
    if (row.status === "COMPLETE") throw new TrainingStateError("Training is already complete.");
    if (row.locked) throw new QuizLockedError("Your quiz is locked. Ask your director to reset it.");

    await tx.volunteerTraining.update({
      where: { id: row.id },
      data: {
        subcommitteeInterest: input.intake.subcommitteeInterest ?? undefined,
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
      await completeTraining(tx, { personId, termId: term.id, cycleId: cycle.id, via: "QUIZ" });
    } else if (attemptsUsed >= cycle.quizMaxAttempts) {
      await tx.volunteerTraining.update({ where: { id: row.id }, data: { locked: true } });
      locked = true;
    }

    const correctByKey = Object.fromEntries(
      questions.filter((q) => q.correctValue !== null).map((q) => [q.key, q.correctValue as string])
    );
    return { score: result.score, total: result.total, percent: result.percent, passed: result.passed, attemptsUsed, locked, correctByKey };
  });
}

/** Clear a locked volunteer so they can retake the quiz. Opens a fresh attempt
 *  window (lockResetAt = now); prior attempts stay in history. Director-scoped or
 *  review_all. */
export async function resetTraining(personId: string, termId: string, actorId: string): Promise<void> {
  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId, kind: "VOLUNTEER", status: "ACTIVE" },
    include: { department: { select: { code: true } } },
  });
  if (memberships.length === 0) throw new TrainingStateError("Not an active volunteer this term.");
  const scope = await reviewScope(actorId);
  const inScope = scope.all || memberships.some((m) => scope.departmentCodes.includes(m.department.code));
  if (!inScope) throw new RecruitmentAuthError("You can't reset training for that volunteer.");

  await prisma.volunteerTraining.updateMany({ where: { personId, termId, status: { not: "COMPLETE" } }, data: { locked: false, lockResetAt: new Date() } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_reset", entityType: "VolunteerTraining", entityId: `${personId}:${termId}` });
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

/** The designated cycle's training roster: in-scope active volunteer memberships
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
      termId: cycle.termId, kind: "VOLUNTEER", status: "ACTIVE",
      ...(scope.all ? {} : { department: { code: { in: scope.departmentCodes } } }),
    },
    include: {
      department: { select: { code: true } },
      person: { select: { id: true, name: true, hipaaCertificates: { orderBy: { uploadedAt: "desc" }, take: 1 } } },
    },
  });

  const personIds = memberships.map((m) => m.person.id);
  const training = new Map(
    (await prisma.volunteerTraining.findMany({ where: { termId: cycle.termId, personId: { in: personIds } } })).map((t) => [t.personId, t])
  );

  return memberships.map((m) => {
    const cert = m.person.hipaaCertificates[0] ?? null;
    const certStatus = complianceStatus(cert ? { completionDate: cert.completionDate } : null, term.endDate);
    const row = training.get(m.person.id);
    const trainingState: TrainingState = row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";
    return {
      personId: m.person.id, name: m.person.name, departmentCode: m.department.code,
      certStatus, trainingState, locked: row?.locked ?? false,
      overallClearance: overallClearance(certStatus, trainingState),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
