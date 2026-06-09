import type { RecruitmentCycle, Prisma, TrainingMethod } from "@prisma/client";
import type { TrainingState } from "@/platform/compliance/rules";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError, reviewScope } from "./review";

export class TrainingStateError extends Error {
  constructor(message: string) { super(message); this.name = "TrainingStateError"; }
}
export class QuizLockedError extends Error {
  constructor(message: string) { super(message); this.name = "QuizLockedError"; }
}

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

  const [scope, canManage] = await Promise.all([reviewScope(actorId), can(actorId, "recruitment.manage_cycles")]);
  const inScope = scope.all || canManage || memberships.some((m) => scope.departmentCodes.includes(m.department.code));
  if (!inScope) throw new RecruitmentAuthError("You can't record training for that volunteer.");

  await completeTraining(prisma, { personId, termId, cycleId: cycle.id, via: "ATTENDANCE", actorId });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_attendance", entityType: "VolunteerTraining", entityId: `${personId}:${termId}`, after: { personId, termId } });
}
