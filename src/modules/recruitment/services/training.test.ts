import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import {
  setTrainingCycle, getTrainingCycleForTerm, updateQuizSettings, TrainingStateError, QuizLockedError,
} from "./training";
import { recordAttendance, resolveTrainingState } from "./training";
import { getMyTraining, submitQuiz, resetTraining } from "./training";

async function seed() {
  const term = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.manage_cycles" }, { permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const plain = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });
  const c1 = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "A", publicSlug: "a", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  const c2 = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "B", publicSlug: "b", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  return { term, srr, plain, c1, c2 };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("designates one training cycle per term; re-designating moves the flag", async () => {
  const { term, srr, c1, c2 } = await seed();
  await setTrainingCycle(c1.id, true, srr.id);
  expect((await getTrainingCycleForTerm(term.id))?.id).toBe(c1.id);
  await setTrainingCycle(c2.id, true, srr.id);
  expect((await getTrainingCycleForTerm(term.id))?.id).toBe(c2.id);
  expect((await prisma.recruitmentCycle.findUnique({ where: { id: c1.id } }))?.isTermTraining).toBe(false);
  await setTrainingCycle(c2.id, false, srr.id);
  expect(await getTrainingCycleForTerm(term.id)).toBeNull();
});

it("requires manage_cycles to designate", async () => {
  const { plain, c1 } = await seed();
  await expect(setTrainingCycle(c1.id, true, plain.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("updates quiz settings within bounds and rejects bad values", async () => {
  const { srr, c1 } = await seed();
  const updated = await updateQuizSettings(c1.id, { quizPassPercent: 90, quizMaxAttempts: 5 }, srr.id);
  expect(updated.quizPassPercent).toBe(90);
  expect(updated.quizMaxAttempts).toBe(5);
  await expect(updateQuizSettings(c1.id, { quizPassPercent: 150, quizMaxAttempts: 5 }, srr.id)).rejects.toBeInstanceOf(TrainingStateError);
  await expect(updateQuizSettings(c1.id, { quizPassPercent: 80, quizMaxAttempts: 0 }, srr.id)).rejects.toBeInstanceOf(TrainingStateError);
});

async function seedMember() {
  const base = await seed();
  const dept = await prisma.department.findUniqueOrThrow({ where: { code: "SRHD" } });
  await setTrainingCycle(base.c1.id, true, base.srr.id);
  const vol = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
  const membership = await prisma.termMembership.create({ data: { personId: vol.id, termId: base.term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  const dir = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: dir.id, termId: base.term.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
  return { ...base, dept, vol, membership, dir };
}

it("records attendance: marks COMPLETE/ATTENDANCE for the person and is idempotent", async () => {
  const { term, srr, vol } = await seedMember();
  await recordAttendance(vol.id, term.id, srr.id);
  expect(await resolveTrainingState(vol.id, term.id)).toBe("COMPLETE");
  const row = await prisma.training.findUniqueOrThrow({ where: { personId_termId_track: { personId: vol.id, termId: term.id, track: "VOLUNTEER" } } });
  expect(row.completedVia).toBe("ATTENDANCE");
  expect(row.attendanceRecordedById).toBe(srr.id);
  await recordAttendance(vol.id, term.id, srr.id);
  expect(await prisma.training.count({ where: { personId: vol.id, termId: term.id } })).toBe(1);
});

it("a director in scope can record attendance; an unrelated person cannot", async () => {
  const { term, vol, dir, plain } = await seedMember();
  await recordAttendance(vol.id, term.id, dir.id);
  expect(await resolveTrainingState(vol.id, term.id)).toBe("COMPLETE");
  await prisma.training.deleteMany({});
  await expect(recordAttendance(vol.id, term.id, plain.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("resolveTrainingState is PENDING with no row (no backfill)", async () => {
  const { term, vol } = await seedMember();
  expect(await resolveTrainingState(vol.id, term.id)).toBe("PENDING");
});

it("recordAttendance fails when the term has no designated training cycle", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  await setTrainingCycle(c1.id, false, srr.id);
  await expect(recordAttendance(vol.id, term.id, srr.id)).rejects.toBeInstanceOf(TrainingStateError);
});

/** Add a 2-question quiz to the designated cycle (both graded). */
async function addQuiz(cycleId: string) {
  const section = await prisma.formSection.create({ data: { cycleId, title: "Quiz", order: 10, appliesTo: "BOTH", purpose: "QUIZ" } });
  await prisma.formField.createMany({ data: [
    { sectionId: section.id, cycleId, key: "q1", label: "Q1", type: "SINGLE_SELECT", order: 0, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], correctValue: "a" },
    { sectionId: section.id, cycleId, key: "q2", label: "Q2", type: "SINGLE_SELECT", order: 1, options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }], correctValue: "y" },
  ] });
}

it("quiz path: failing accrues attempts then locks; passing completes and saves intake", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  await updateQuizSettings(c1.id, { quizPassPercent: 100, quizMaxAttempts: 2 }, srr.id);
  await addQuiz(c1.id);

  const r1 = await submitQuiz(vol.id, { answers: { q1: "a", q2: "x" }, intake: { feedback: "hi" } });
  expect(r1.passed).toBe(false);
  // Review payload powers the in-place correct/wrong highlighting on the page.
  expect(r1.attemptsUsed).toBe(1);
  expect(r1.locked).toBe(false);
  expect(r1.correctByKey).toEqual({ q1: "a", q2: "y" });
  expect(await resolveTrainingState(vol.id, term.id)).toBe("PENDING");

  const r2 = await submitQuiz(vol.id, { answers: { q1: "a", q2: "x" }, intake: {} });
  expect(r2.passed).toBe(false);
  expect(r2.attemptsUsed).toBe(2);
  expect(r2.locked).toBe(true);
  const locked = await prisma.training.findUniqueOrThrow({ where: { personId_termId_track: { personId: vol.id, termId: term.id, track: "VOLUNTEER" } } });
  expect(locked.locked).toBe(true);

  await expect(submitQuiz(vol.id, { answers: { q1: "a", q2: "y" }, intake: {} })).rejects.toBeInstanceOf(QuizLockedError);

  await resetTraining(vol.id, term.id, srr.id);
  const r3 = await submitQuiz(vol.id, { answers: { q1: "a", q2: "y" }, intake: { feedback: "done" } });
  expect(r3.passed).toBe(true);
  const done = await prisma.training.findUniqueOrThrow({ where: { personId_termId_track: { personId: vol.id, termId: term.id, track: "VOLUNTEER" } } });
  expect(done.status).toBe("COMPLETE");
  expect(done.completedVia).toBe("QUIZ");
  expect(done.feedback).toBe("done");
  expect(await prisma.quizAttempt.count({ where: { training: { personId: vol.id, termId: term.id, track: "VOLUNTEER" } } })).toBe(3);
});

it("getMyTraining returns the cycle, questions, and state for the volunteer", async () => {
  const { vol, c1 } = await seedMember();
  await addQuiz(c1.id);
  const my = await getMyTraining(vol.id);
  expect(my.state).toBe("PENDING");
  expect(my.locked).toBe(false);
  expect(my.questions.map((q) => q.key)).toEqual(["q1", "q2"]);
});

it("submitQuiz rejects when already complete", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  await addQuiz(c1.id);
  await recordAttendance(vol.id, term.id, srr.id);
  await expect(submitQuiz(vol.id, { answers: { q1: "a", q2: "y" }, intake: {} })).rejects.toBeInstanceOf(TrainingStateError);
});

import { listTrainingRoster } from "./training";

it("listTrainingRoster lists in-scope active volunteers with cert + training state", async () => {
  const { srr, vol, c1, dept } = await seedMember();
  await prisma.hipaaCertificate.create({ data: { personId: vol.id, fileName: "c.pdf", storedName: "c.pdf", size: 1, mimeType: "application/pdf", completionDate: new Date() } });
  const rows = await listTrainingRoster(c1.id, srr.id);
  const row = rows.find((r) => r.personId === vol.id)!;
  expect(row.departmentCode).toBe(dept.code);
  expect(row.trainingState).toBe("PENDING");
  expect(row.overallClearance).toBe("NOT_CLEARED"); // cert valid but training pending
});

it("listTrainingRoster rejects a cycle that is not the term training cycle", async () => {
  const { srr, c2 } = await seedMember(); // c2 is not designated
  await expect(listTrainingRoster(c2.id, srr.id)).rejects.toBeInstanceOf(TrainingStateError);
});
