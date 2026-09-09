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

/* Live-session attendance used to be recorded here, by `recordAttendance`, which
 * required the person to hold an ACTIVE TermMembership of the cycle's track. That
 * requirement is exactly what made two real situations unrecordable -- an info
 * session full of prospective applicants, and training attended by someone whose
 * onboarding contract had not been submitted yet -- so attendance moved to
 * ./attendance-events.ts, where it is recorded against an event and the training
 * completion is a consequence of it. The roster's per-row button now routes
 * through recordEventCheckIn, and completeTraining above is the shared write both
 * that path and the quiz path still use. */

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

/** One excused absence from a cycle's in-person training session, as a reader
 *  sees it on the roster or on an applicant's profile. */
export type TrainingExcuse = {
  reason: string;
  recordedByName: string | null;
  recordedAt: Date;
  /** True when the row is still keyed on an email because the person has no hub
   *  account yet. The applicant profile says so; it explains why an excuse
   *  entered here is not on the training roster until they are promoted. */
  unlinked: boolean;
};

/** Which row an excuse belongs to. A member on the training roster is keyed on
 *  their Person; an applicant with no account is keyed on their lowercased email
 *  until promotion gives them one. */
type ExcuseIdentity = { personId: string; emailLower?: undefined } | { personId?: undefined; emailLower: string };

async function requireExcuseLead(actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new RecruitmentAuthError("Only recruitment leads can excuse a training absence.");
  }
}

function selectExcuse(row: {
  reason: string;
  recordedAt: Date;
  personId: string | null;
  recordedBy: { name: string } | null;
}): TrainingExcuse {
  return {
    reason: row.reason,
    recordedByName: row.recordedBy?.name ?? null,
    recordedAt: row.recordedAt,
    unlinked: row.personId === null,
  };
}

/**
 * The shared write behind both entry points.
 *
 * Upserts on whichever unique key the identity picks, so a second excuse for the
 * same person edits the reason rather than stacking rows: there is only one
 * answer to "why were they not there".
 */
async function writeExcuse(
  cycleId: string,
  identity: ExcuseIdentity,
  reason: string,
  actorId: string
): Promise<void> {
  // Required, not optional: an excuse with no reason reads the same as a bare
  // absence, which is the thing this exists to fix.
  const clean = reason.trim();
  if (clean.length === 0) throw new TrainingStateError("Give the reason they gave you.");

  const row = await prisma.trainingAbsenceExcuse.upsert({
    where:
      identity.personId !== undefined
        ? { cycleId_personId: { cycleId, personId: identity.personId } }
        : { cycleId_emailLower: { cycleId, emailLower: identity.emailLower } },
    create: { cycleId, ...identity, reason: clean, recordedById: actorId },
    // recordedAt moves with the edit: the record should say when we last heard
    // this, and who took it down.
    update: { reason: clean, recordedById: actorId, recordedAt: new Date() },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.training_excuse",
    entityType: "TrainingAbsenceExcuse",
    entityId: row.id,
    after: { cycleId, ...identity, reason: clean },
  });
}

/**
 * Excuse a member listed on the cycle's training roster.
 *
 * Excuses reach the clinic by email before the session, so this is a lead writing
 * one down, not the member claiming it -- hence manage_cycles rather than the
 * department-scoped reach that records attendance.
 *
 * Purely a record. It does not complete training, waive the makeup quiz, or move
 * the makeup window: the person still owes the quiz on the normal schedule. What
 * it buys is a roster that can tell someone who warned us apart from someone who
 * simply never turned up.
 */
export async function recordAbsenceExcuse(
  cycleId: string,
  personId: string,
  reason: string,
  actorId: string
): Promise<void> {
  await requireExcuseLead(actorId);

  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new TrainingStateError("Cycle not found.");
  // This entry point is the roster's own button, so the roster's own membership
  // rule is the right guard. Excusing someone not yet accepted goes through
  // recordApplicantAbsenceExcuse instead, which validates against the cycle's
  // applicants.
  const onRoster = await prisma.termMembership.findFirst({
    where: { personId, termId: cycle.termId, kind: cycle.track, status: "ACTIVE" },
    select: { id: true },
  });
  if (!onRoster) throw new TrainingStateError("Not an active member of this track this term.");

  await writeExcuse(cycleId, { personId }, reason, actorId);
}

/**
 * Excuse an applicant, who may not be accepted yet and may have no hub account
 * at all.
 *
 * This is the surface that matters in practice: excuses arrive during the weeks
 * around the session, well before promotion turns anyone into a member, and the
 * roster does not list them yet.
 *
 * Stores a personId whenever one can be resolved -- the applicant's linked
 * account, or a Person whose contact email matches -- so the excuse is on the
 * roster immediately rather than waiting to be matched. Only a genuinely unknown
 * applicant falls back to the email key.
 */
export async function recordApplicantAbsenceExcuse(
  cycleId: string,
  applicantId: string,
  reason: string,
  actorId: string
): Promise<void> {
  await requireExcuseLead(actorId);
  const identity = await resolveApplicantIdentity(cycleId, applicantId);
  await writeExcuse(cycleId, identity, reason, actorId);
}

/** The applicant's excuse, or null. Reads by whichever key they were stored
 *  under, so a lead sees the same excuse whether it was entered here or on the
 *  roster after they were promoted. */
export async function getApplicantAbsenceExcuse(
  cycleId: string,
  applicantId: string
): Promise<TrainingExcuse | null> {
  const identity = await resolveApplicantIdentity(cycleId, applicantId);
  const row = await prisma.trainingAbsenceExcuse.findFirst({
    where: { cycleId, ...identity },
    include: { recordedBy: { select: { name: true } } },
  });
  return row ? selectExcuse(row) : null;
}

/**
 * An applicant's excuse identity: their Person if one can be found, their
 * lowercased email otherwise.
 *
 * Applicant.applicantPersonId is only set for signed-in renewals and promotion
 * never backfills it, so the email match is not a fallback for odd cases -- it is
 * how most promoted applicants are found.
 */
async function resolveApplicantIdentity(cycleId: string, applicantId: string): Promise<ExcuseIdentity> {
  const applicant = await prisma.applicant.findUnique({
    where: { id: applicantId },
    select: { cycleId: true, applicantPersonId: true, emailLower: true },
  });
  if (!applicant) throw new TrainingStateError("Applicant not found.");
  // Guards against an applicant id from another cycle being posted at this one,
  // which would file the excuse against the wrong training session.
  if (applicant.cycleId !== cycleId) throw new TrainingStateError("That applicant is not in this cycle.");

  if (applicant.applicantPersonId) return { personId: applicant.applicantPersonId };
  const match = await prisma.person.findFirst({
    where: { contactEmail: { equals: applicant.emailLower, mode: "insensitive" } },
    select: { id: true },
  });
  return match ? { personId: match.id } : { emailLower: applicant.emailLower };
}

/** Withdraw a roster member's excuse. Idempotent: clearing one that is already
 *  gone is the state the caller asked for, not an error, so a double submit or a
 *  stale page is harmless. */
export async function clearAbsenceExcuse(cycleId: string, personId: string, actorId: string): Promise<void> {
  await requireExcuseLead(actorId);
  await deleteExcuse(cycleId, { personId }, actorId);
}

/** Withdraw an applicant's excuse, by whichever key it was stored under. */
export async function clearApplicantAbsenceExcuse(
  cycleId: string,
  applicantId: string,
  actorId: string
): Promise<void> {
  await requireExcuseLead(actorId);
  await deleteExcuse(cycleId, await resolveApplicantIdentity(cycleId, applicantId), actorId);
}

async function deleteExcuse(cycleId: string, identity: ExcuseIdentity, actorId: string): Promise<void> {
  const { count } = await prisma.trainingAbsenceExcuse.deleteMany({ where: { cycleId, ...identity } });
  if (count === 0) return;
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.training_excuse_cleared",
    entityType: "TrainingAbsenceExcuse",
    entityId: `${cycleId}:${identity.personId ?? identity.emailLower}`,
    before: { cycleId, ...identity },
  });
}

type TrainingRosterFields = {
  name: string;
  departmentCode: string;
  certStatus: ReturnType<typeof complianceStatus>;
  trainingState: TrainingState;
  locked: boolean;
  /**
   * Widened past OverallClearance for the roster's second half. An accepted
   * applicant has no membership, so there is no certificate to check and no
   * clearance to compute -- see clearanceLabel for why that is a third state
   * rather than "Not cleared".
   */
  overallClearance: OverallClearance | "NOT_ONBOARDED";
  /** Set when a lead recorded an absence excused ahead of the session. Kept even
   *  after training completes: "COMPLETE, excused" is the true story of someone
   *  who missed the session with warning and finished by makeup quiz. */
  excuse: TrainingExcuse | null;
};

/**
 * One person expected at this cycle's training, in one of two shapes.
 *
 * A discriminated union rather than a row with three nullable ids, because the
 * two halves are acted on through different services -- a member by personId, an
 * accepted applicant by an acceptance (to check in) or an applicant (to excuse)
 * -- and a caller that forgets which it is holding should not typecheck.
 */
export type TrainingRosterRow =
  | (TrainingRosterFields & { kind: "member"; personId: string })
  | (TrainingRosterFields & {
      kind: "applicant";
      /** The check-in target: recordEventCheckIn takes an acceptance. */
      acceptanceId: string;
      /** The excuse key: recordApplicantAbsenceExcuse takes an applicant. */
      applicantId: string;
    });

/**
 * Everyone expected at this cycle's training session.
 *
 * TWO sources, because a `Person` does not exist until promotion.
 *
 * The roster half is in-scope ACTIVE memberships of the cycle's track. The other
 * half is the cycle's ACCEPTANCES whose contract has not promoted: people the
 * clinic has decided are volunteers, who owe a training session, and who have no
 * account for a membership query to find. Listing only the first half made this
 * page empty in the weeks it is most wanted -- acceptances go out, nobody has
 * onboarded yet, and the table shows nothing at all -- and then made it quietly
 * partial for the rest of the cycle. (The check-in door at /check-in has always
 * read both; this brings the roster into line with it.)
 *
 * Deduped on lowercased email, so somebody who was promoted between the two
 * queries does not appear as both.
 *
 * Director-scoped or review_all. A scoped viewer's applicant half is filtered on
 * `Acceptance.departmentCode`, which is the same departmental fact their
 * membership filter uses -- unlike the door, where an unlinked WRITE is a
 * clinic-wide assertion with no department to check. Reading the row is
 * departmental; the page gates the button separately.
 *
 * Throws TrainingStateError if the cycle is not the designated training cycle
 * for its term.
 */
export async function listTrainingRoster(cycleId: string, viewerId: string): Promise<TrainingRosterRow[]> {
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new TrainingStateError("Cycle not found.");
  if (!cycle.isTermTraining) throw new TrainingStateError("This cycle is not the term's training cycle.");

  const term = await prisma.term.findUniqueOrThrow({ where: { id: cycle.termId } });
  const scope = await reviewScope(viewerId);

  const [memberships, acceptances] = await Promise.all([
    prisma.termMembership.findMany({
      where: {
        termId: cycle.termId, kind: cycle.track, status: "ACTIVE",
        ...(scope.all ? {} : { department: { code: { in: scope.departmentCodes } } }),
      },
      include: {
        department: { select: { code: true } },
        person: { select: { id: true, name: true, contactEmail: true, hipaaCertificates: { orderBy: { uploadedAt: "desc" }, take: 1 } } },
      },
    }),
    prisma.acceptance.findMany({
      where: {
        application: { cycleId },
        ...(scope.all ? {} : { departmentCode: { in: scope.departmentCodes } }),
      },
      select: {
        id: true,
        departmentCode: true,
        // Promotion is what creates the Person, so this is the authoritative
        // "already in the membership half above" link.
        contract: { select: { promotedPersonId: true } },
        application: {
          select: { applicant: { select: { id: true, firstName: true, lastName: true, emailLower: true } } },
        },
      },
    }),
  ]);

  const personIds = memberships.map((m) => m.person.id);
  const memberEmails = new Set(
    memberships.flatMap((m) => (m.person.contactEmail ? [m.person.contactEmail.toLowerCase()] : [])),
  );
  const pending = acceptances.filter(
    (a) =>
      !a.contract?.promotedPersonId && !memberEmails.has(a.application.applicant.emailLower),
  );
  const pendingEmails = pending.map((a) => a.application.applicant.emailLower);

  // An excuse written against an applicant before they had an account is keyed
  // on their email, so the roster has to ask for it that way too: without this,
  // an excuse recorded in October would vanish the moment promotion made them a
  // member, which is exactly when the roster starts judging them. The pending
  // half is read through the same map, since an excuse for someone with no
  // Person can only ever have been stored under their email.
  const emailsLower = [...memberEmails, ...pendingEmails];
  const [trainingRows, excuseRows, pendingAttendance] = await Promise.all([
    prisma.training.findMany({ where: { termId: cycle.termId, track: cycle.track, personId: { in: personIds } } }),
    prisma.trainingAbsenceExcuse.findMany({
      where: { cycleId, OR: [{ personId: { in: personIds } }, { emailLower: { in: emailsLower } }] },
      include: { recordedBy: { select: { name: true } } },
    }),
    // The pending half's training state cannot come from the Training table:
    // completeTraining is keyed on personId, and these people have none. Their
    // attendance row IS the record, and it is what promotion later converts into
    // a Training row (see attendance-events' linkAttendanceByEmail).
    pendingEmails.length === 0
      ? Promise.resolve([])
      : prisma.eventAttendance.findMany({
          where: { event: { cycleId, kind: "TRAINING" }, attendeeEmail: { in: pendingEmails } },
          select: { attendeeEmail: true },
        }),
  ]);
  const attended = new Set(
    pendingAttendance.flatMap((a) => (a.attendeeEmail ? [a.attendeeEmail.toLowerCase()] : [])),
  );
  const training = new Map(trainingRows.map((t) => [t.personId, t]));
  const excusesByPerson = new Map<string, TrainingExcuse>();
  const excusesByEmail = new Map<string, TrainingExcuse>();
  for (const row of excuseRows) {
    if (row.personId) excusesByPerson.set(row.personId, selectExcuse(row));
    else if (row.emailLower) excusesByEmail.set(row.emailLower, selectExcuse(row));
  }
  // Person-keyed wins: if a lead excused someone on the roster and an older
  // email-keyed row from their applicant days is still around, the one written
  // about the member they are now is the current answer.
  const excuseFor = (personId: string, email: string | null): TrainingExcuse | null =>
    excusesByPerson.get(personId) ?? (email ? excusesByEmail.get(email.toLowerCase()) ?? null : null);

  const memberRows: TrainingRosterRow[] = memberships.map((m) => {
    const cert = m.person.hipaaCertificates[0] ?? null;
    const certStatus = complianceStatus(cert ? { completionDate: cert.completionDate, verifiedAt: cert.verifiedAt } : null, term.endDate);
    const row = training.get(m.person.id);
    const trainingState: TrainingState = row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";
    return {
      kind: "member",
      personId: m.person.id, name: m.person.name, departmentCode: m.department.code,
      certStatus, trainingState, locked: row?.locked ?? false,
      overallClearance: overallClearance(certStatus, trainingState === "COMPLETE"),
      excuse: excuseFor(m.person.id, m.person.contactEmail),
    };
  });

  const pendingRows: TrainingRosterRow[] = pending.map((a) => {
    const applicant = a.application.applicant;
    const trainingState: TrainingState = attended.has(applicant.emailLower) ? "COMPLETE" : "PENDING";
    return {
      kind: "applicant",
      acceptanceId: a.id,
      applicantId: applicant.id,
      name: `${applicant.firstName} ${applicant.lastName}`.trim(),
      departmentCode: a.departmentCode,
      // NO_CERTIFICATE is the honest answer, not a placeholder: HipaaCertificate
      // rows hang off a Person, and promotion is what creates both the Person and
      // the certificate from whatever they uploaded with their contract. Until
      // then the clinic genuinely holds no certificate for them.
      certStatus: complianceStatus(null, term.endDate),
      trainingState,
      // Locking is a quiz-attempt state on a Training row they cannot have.
      locked: false,
      // Its own state, not NOT_CLEARED. Attendance alone must not make them look
      // ready -- the contract that puts them on the roster is still outstanding --
      // but they have not failed a check either: there is nothing to check yet.
      overallClearance: "NOT_ONBOARDED",
      excuse: excusesByEmail.get(applicant.emailLower) ?? null,
    };
  });

  // Interleaved, not appended. A lead reading this in the run-up to a session is
  // looking for a name, and two alphabetical lists is two places to look for it.
  return [...memberRows, ...pendingRows].sort((a, b) => a.name.localeCompare(b.name));
}
