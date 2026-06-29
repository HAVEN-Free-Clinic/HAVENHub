import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import {
  setTrainingCycle, getTrainingCycleForTerm, updateQuizSettings, TrainingStateError, QuizLockedError,
  requiredTrainingTracks,
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
  expect((await getTrainingCycleForTerm(term.id, "VOLUNTEER"))?.id).toBe(c1.id);
  await setTrainingCycle(c2.id, true, srr.id);
  expect((await getTrainingCycleForTerm(term.id, "VOLUNTEER"))?.id).toBe(c2.id);
  expect((await prisma.recruitmentCycle.findUnique({ where: { id: c1.id } }))?.isTermTraining).toBe(false);
  await setTrainingCycle(c2.id, false, srr.id);
  expect(await getTrainingCycleForTerm(term.id, "VOLUNTEER")).toBeNull();
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
  await recordAttendance(vol.id, term.id, "VOLUNTEER", srr.id);
  expect(await resolveTrainingState(vol.id, term.id, "VOLUNTEER")).toBe("COMPLETE");
  const row = await prisma.training.findUniqueOrThrow({ where: { personId_termId_track: { personId: vol.id, termId: term.id, track: "VOLUNTEER" } } });
  expect(row.completedVia).toBe("ATTENDANCE");
  expect(row.attendanceRecordedById).toBe(srr.id);
  await recordAttendance(vol.id, term.id, "VOLUNTEER", srr.id);
  expect(await prisma.training.count({ where: { personId: vol.id, termId: term.id } })).toBe(1);
});

it("a director in scope can record attendance; an unrelated person cannot", async () => {
  const { term, vol, dir, plain } = await seedMember();
  await recordAttendance(vol.id, term.id, "VOLUNTEER", dir.id);
  expect(await resolveTrainingState(vol.id, term.id, "VOLUNTEER")).toBe("COMPLETE");
  await prisma.training.deleteMany({});
  await expect(recordAttendance(vol.id, term.id, "VOLUNTEER", plain.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("resolveTrainingState is PENDING with no row (no backfill)", async () => {
  const { term, vol } = await seedMember();
  expect(await resolveTrainingState(vol.id, term.id, "VOLUNTEER")).toBe("PENDING");
});

it("recordAttendance fails when the term has no designated training cycle", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  await setTrainingCycle(c1.id, false, srr.id);
  await expect(recordAttendance(vol.id, term.id, "VOLUNTEER", srr.id)).rejects.toBeInstanceOf(TrainingStateError);
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

  const r1 = await submitQuiz(vol.id, { track: "VOLUNTEER", answers: { q1: "a", q2: "x" }, intake: { feedback: "hi" } });
  expect(r1.passed).toBe(false);
  // Review payload powers the in-place correct/wrong highlighting on the page.
  expect(r1.attemptsUsed).toBe(1);
  expect(r1.locked).toBe(false);
  expect(r1.correctByKey).toEqual({ q1: "a", q2: "y" });
  expect(await resolveTrainingState(vol.id, term.id, "VOLUNTEER")).toBe("PENDING");

  const r2 = await submitQuiz(vol.id, { track: "VOLUNTEER", answers: { q1: "a", q2: "x" }, intake: {} });
  expect(r2.passed).toBe(false);
  expect(r2.attemptsUsed).toBe(2);
  expect(r2.locked).toBe(true);
  const locked = await prisma.training.findUniqueOrThrow({ where: { personId_termId_track: { personId: vol.id, termId: term.id, track: "VOLUNTEER" } } });
  expect(locked.locked).toBe(true);

  await expect(submitQuiz(vol.id, { track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: {} })).rejects.toBeInstanceOf(QuizLockedError);

  await resetTraining(vol.id, term.id, "VOLUNTEER", srr.id);
  const r3 = await submitQuiz(vol.id, { track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: { feedback: "done" } });
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
  const trainings = await getMyTraining(vol.id);
  const my = trainings[0]!;
  expect(my.state).toBe("PENDING");
  expect(my.locked).toBe(false);
  expect(my.questions.map((q) => q.key)).toEqual(["q1", "q2"]);
});

it("submitQuiz rejects when already complete", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  await addQuiz(c1.id);
  await recordAttendance(vol.id, term.id, "VOLUNTEER", srr.id);
  await expect(submitQuiz(vol.id, { track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: {} })).rejects.toBeInstanceOf(TrainingStateError);
});

import { listTrainingRoster } from "./training";

it("listTrainingRoster lists in-scope active volunteers with cert + training state", async () => {
  const { srr, vol, c1, dept } = await seedMember();
  await prisma.hipaaCertificate.create({ data: { personId: vol.id, fileName: "c.pdf", storedName: "c.pdf", size: 1, mimeType: "application/pdf", completionDate: new Date(), verifiedAt: new Date() } });
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

it("a term can have one volunteer and one director training cycle at once", async () => {
  const { srr, term, c1 } = await seed();
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(c1.id, true, srr.id);        // volunteer
  await setTrainingCycle(dirCycle.id, true, srr.id);  // director
  expect((await getTrainingCycleForTerm(term.id, "VOLUNTEER"))?.id).toBe(c1.id);
  expect((await getTrainingCycleForTerm(term.id, "DIRECTOR"))?.id).toBe(dirCycle.id);
});

it("designating a second cycle of a track clears the first of that track only", async () => {
  const { srr, term, c1, c2 } = await seed();
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(c1.id, true, srr.id);
  await setTrainingCycle(dirCycle.id, true, srr.id);
  await setTrainingCycle(c2.id, true, srr.id); // second VOLUNTEER cycle
  expect((await getTrainingCycleForTerm(term.id, "VOLUNTEER"))?.id).toBe(c2.id);
  expect((await getTrainingCycleForTerm(term.id, "DIRECTOR"))?.id).toBe(dirCycle.id); // untouched
});

it("requiredTrainingTracks reflects membership kind ∩ designated cycles", async () => {
  const { term, srr, vol, dir } = await seedMember(); // volunteer cycle c1 is designated
  // volunteer-only, volunteer cycle running -> [VOLUNTEER]
  expect(await requiredTrainingTracks(vol.id, term.id)).toEqual(["VOLUNTEER"]);
  // director-only, no director cycle -> []
  expect(await requiredTrainingTracks(dir.id, term.id)).toEqual([]);

  // designate a director cycle
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(dirCycle.id, true, srr.id);
  // director-only now -> [DIRECTOR]
  expect(await requiredTrainingTracks(dir.id, term.id)).toEqual(["DIRECTOR"]);
});

it("requiredTrainingTracks returns both tracks for a director+volunteer when both cycles run", async () => {
  const { term, srr, vol, dept } = await seedMember();
  await prisma.termMembership.create({ data: { personId: vol.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(dirCycle.id, true, srr.id);
  expect(await requiredTrainingTracks(vol.id, term.id)).toEqual(["VOLUNTEER", "DIRECTOR"]);
});

it("a director completes director training via the quiz", async () => {
  const { term, srr, dir } = await seedMember();
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(dirCycle.id, true, srr.id);
  await updateQuizSettings(dirCycle.id, { quizPassPercent: 100, quizMaxAttempts: 2 }, srr.id);
  await addQuiz(dirCycle.id);

  const r = await submitQuiz(dir.id, { track: "DIRECTOR", answers: { q1: "a", q2: "y" }, intake: {} });
  expect(r.passed).toBe(true);
  expect(await resolveTrainingState(dir.id, term.id, "DIRECTOR")).toBe("COMPLETE");
  // their (nonexistent) volunteer training is untouched
  expect(await resolveTrainingState(dir.id, term.id, "VOLUNTEER")).toBe("PENDING");
});

it("submitQuiz rejects a track the person has no active membership for", async () => {
  const { term, srr, vol } = await seedMember();
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(dirCycle.id, true, srr.id);
  await addQuiz(dirCycle.id);
  await expect(submitQuiz(vol.id, { track: "DIRECTOR", answers: { q1: "a", q2: "y" }, intake: {} }))
    .rejects.toBeInstanceOf(TrainingStateError); // vol is not an active director
});

it("getMyTraining returns one entry per required track", async () => {
  const { term, srr, vol, dept } = await seedMember(); // volunteer cycle designated; vol is volunteer
  // volunteer-only
  const volOnly = await getMyTraining(vol.id);
  expect(volOnly.map((m) => m.track)).toEqual(["VOLUNTEER"]);
  expect(volOnly[0].trackLabel).toBe("Volunteer training");

  // make vol also a director and run a director cycle
  await prisma.termMembership.create({ data: { personId: vol.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(dirCycle.id, true, srr.id);
  const both = await getMyTraining(vol.id);
  expect(both.map((m) => m.track)).toEqual(["VOLUNTEER", "DIRECTOR"]);
  expect(both.map((m) => m.trackLabel)).toEqual(["Volunteer training", "Director training"]);
});

it("getMyTraining is empty for a director-only person with no director cycle", async () => {
  const { dir } = await seedMember();
  expect(await getMyTraining(dir.id)).toEqual([]);
});

it("listTrainingRoster for a DIRECTOR cycle lists directors not volunteers", async () => {
  const { term, srr, vol, dir } = await seedMember();
  const dirCycle = await prisma.recruitmentCycle.create({
    data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" },
  });
  await setTrainingCycle(dirCycle.id, true, srr.id);

  const rows = await listTrainingRoster(dirCycle.id, srr.id);
  const ids = rows.map((r) => r.personId);
  expect(ids).toContain(dir.id);
  expect(ids).not.toContain(vol.id);
  const dirRow = rows.find((r) => r.personId === dir.id)!;
  expect(dirRow.trainingState).toBe("PENDING");
});
