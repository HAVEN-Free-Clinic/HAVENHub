import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import {
  setTrainingCycle, getTrainingCycleForTerm, updateQuizSettings, TrainingStateError, QuizLockedError,
  requiredTrainingTracks,
} from "./training";
import { completeTraining, resolveTrainingState } from "./training";
import { getMyTraining, submitQuiz, resetTraining, listTrainingRoster } from "./training";
import {
  recordAbsenceExcuse,
  clearAbsenceExcuse,
  recordApplicantAbsenceExcuse,
  clearApplicantAbsenceExcuse,
  getApplicantAbsenceExcuse,
} from "./training";
import type { TrainingRosterRow } from "./training";
import type { ApplicantType } from "@prisma/client";

/**
 * The roster row for a promoted member, narrowed.
 *
 * The roster carries two shapes now (see TrainingRosterRow) and only one of them
 * has a personId, so the tests below say which they mean rather than reaching
 * through the union.
 */
function memberRow(rows: TrainingRosterRow[], personId: string) {
  const row = rows.find((r) => r.kind === "member" && r.personId === personId);
  if (!row || row.kind !== "member") throw new Error(`no member row for ${personId}`);
  return row;
}

/** Member personIds on the roster, in order. Applicant rows have none. */
function memberIds(rows: TrainingRosterRow[]): string[] {
  return rows.flatMap((r) => (r.kind === "member" ? [r.personId] : []));
}

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
  await addQuiz(c1.id);
  await setTrainingCycle(c1.id, true, srr.id);
  expect((await getTrainingCycleForTerm(term.id, "VOLUNTEER"))?.id).toBe(c1.id);
  await addQuiz(c2.id);
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

it("refuses to designate a cycle whose quiz has no keyed questions", async () => {
  const { srr, c1 } = await seed(); // no quiz seeded on c1
  await expect(setTrainingCycle(c1.id, true, srr.id)).rejects.toBeInstanceOf(TrainingStateError);
  expect((await prisma.recruitmentCycle.findUnique({ where: { id: c1.id } }))?.isTermTraining).toBe(false);
});

// The case the guard exists for: questions.length is non-zero (2, from addQuiz),
// so the old `questions.length === 0` check would have let this through. Only
// countGradedQuestions(...) === 0 catches a quiz whose keys were all stripped.
it("refuses to designate a cycle whose quiz has questions but none are keyed", async () => {
  const { srr, c1 } = await seed();
  await addQuiz(c1.id);
  await prisma.formField.updateMany({ where: { cycleId: c1.id }, data: { correctValue: null } });
  await expect(setTrainingCycle(c1.id, true, srr.id)).rejects.toBeInstanceOf(TrainingStateError);
  expect((await prisma.recruitmentCycle.findUnique({ where: { id: c1.id } }))?.isTermTraining).toBe(false);
});

it("designates successfully once the cycle has at least one keyed question", async () => {
  const { term, srr, c1 } = await seed();
  await addQuiz(c1.id);
  await setTrainingCycle(c1.id, true, srr.id);
  expect((await getTrainingCycleForTerm(term.id, "VOLUNTEER"))?.id).toBe(c1.id);
});

it("clearing a designation (value: false) still works on a quiz-less cycle", async () => {
  const { srr, c1 } = await seed();
  // Simulate a cycle designated before this guard shipped: flip the flag
  // directly, bypassing setTrainingCycle, so c1 is designated with no quiz.
  await prisma.recruitmentCycle.update({ where: { id: c1.id }, data: { isTermTraining: true } });
  await setTrainingCycle(c1.id, false, srr.id);
  expect((await prisma.recruitmentCycle.findUnique({ where: { id: c1.id } }))?.isTermTraining).toBe(false);
});

it("updates quiz settings within bounds and rejects bad values", async () => {
  const { srr, c1 } = await seed();
  const updated = await updateQuizSettings(c1.id, { quizPassPercent: 90, quizMaxAttempts: 5, inPersonTrainingDate: null, trainingLocation: null }, srr.id);
  expect(updated.quizPassPercent).toBe(90);
  expect(updated.quizMaxAttempts).toBe(5);
  await expect(updateQuizSettings(c1.id, { quizPassPercent: 150, quizMaxAttempts: 5, inPersonTrainingDate: null, trainingLocation: null }, srr.id)).rejects.toBeInstanceOf(TrainingStateError);
  await expect(updateQuizSettings(c1.id, { quizPassPercent: 80, quizMaxAttempts: 0, inPersonTrainingDate: null, trainingLocation: null }, srr.id)).rejects.toBeInstanceOf(TrainingStateError);
});

it("normalizes trainingLocation: trims, and stores a whitespace-only value as null", async () => {
  const { srr, c1 } = await seed();
  const trimmed = await updateQuizSettings(c1.id, { quizPassPercent: 90, quizMaxAttempts: 5, inPersonTrainingDate: null, trainingLocation: "  on Zoom at 10 AM  " }, srr.id);
  expect(trimmed.trainingLocation).toBe("on Zoom at 10 AM");
  const blank = await updateQuizSettings(c1.id, { quizPassPercent: 90, quizMaxAttempts: 5, inPersonTrainingDate: null, trainingLocation: "   " }, srr.id);
  expect(blank.trainingLocation).toBeNull();
});

async function seedMember() {
  const base = await seed();
  const dept = await prisma.department.findUniqueOrThrow({ where: { code: "SRHD" } });
  // The designation guard requires at least one keyed question, so every seedMember
  // caller gets a real quiz on c1 for free; tests that used to seed their own now
  // reuse this one instead of inserting a colliding duplicate.
  await addQuiz(base.c1.id);
  await setTrainingCycle(base.c1.id, true, base.srr.id);
  const vol = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
  const membership = await prisma.termMembership.create({ data: { personId: vol.id, termId: base.term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  const dir = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: dir.id, termId: base.term.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
  return { ...base, dept, vol, membership, dir };
}

/* The three tests that used to live here -- attendance is idempotent, a director
 * in scope may record it and an unrelated person may not -- moved with the
 * behavior itself to ./attendance-events.test.ts, which exercises them through
 * recordEventCheckIn. What stays here is completeTraining, the shared write both
 * the attendance path and the quiz path go through. */

it("completeTraining via ATTENDANCE marks COMPLETE and is idempotent", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  const args = { personId: vol.id, termId: term.id, cycleId: c1.id, track: "VOLUNTEER" as const, via: "ATTENDANCE" as const, actorId: srr.id };
  await completeTraining(prisma, args);
  expect(await resolveTrainingState(vol.id, term.id, "VOLUNTEER")).toBe("COMPLETE");
  const row = await prisma.training.findUniqueOrThrow({ where: { personId_termId_track: { personId: vol.id, termId: term.id, track: "VOLUNTEER" } } });
  expect(row.completedVia).toBe("ATTENDANCE");
  expect(row.attendanceRecordedById).toBe(srr.id);
  await completeTraining(prisma, args);
  expect(await prisma.training.count({ where: { personId: vol.id, termId: term.id } })).toBe(1);
});

it("resolveTrainingState is PENDING with no row (no backfill)", async () => {
  const { term, vol } = await seedMember();
  expect(await resolveTrainingState(vol.id, term.id, "VOLUNTEER")).toBe("PENDING");
});

/** Add a 2-question quiz to a cycle (both graded). Called before designation now
 *  that setTrainingCycle requires a keyed question, including on cycles that are
 *  never designated or whose designation is later superseded. */
async function addQuiz(cycleId: string) {
  const section = await prisma.formSection.create({ data: { cycleId, title: "Quiz", order: 10, appliesTo: "BOTH", purpose: "QUIZ" } });
  await prisma.formField.createMany({ data: [
    { sectionId: section.id, cycleId, key: "q1", label: "Q1", type: "SINGLE_SELECT", order: 0, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], correctValue: "a" },
    { sectionId: section.id, cycleId, key: "q2", label: "Q2", type: "SINGLE_SELECT", order: 1, options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }], correctValue: "y" },
  ] });
}

it("quiz path: failing accrues attempts then locks; passing completes and saves intake", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  // seedMember already seeded c1's quiz (q1 correct "a", q2 correct "y") to
  // satisfy the designation guard; reuse it rather than inserting it again.
  await updateQuizSettings(c1.id, { quizPassPercent: 100, quizMaxAttempts: 2, inPersonTrainingDate: null, trainingLocation: null }, srr.id);

  const r1 = await submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "x" }, intake: { feedback: "hi" } });
  expect(r1.passed).toBe(false);
  // Review payload powers the in-place correct/wrong highlighting on the page.
  expect(r1.attemptsUsed).toBe(1);
  expect(r1.locked).toBe(false);
  expect(r1.verdictByKey).toEqual({ q1: "correct", q2: "wrong" });
  expect(await resolveTrainingState(vol.id, term.id, "VOLUNTEER")).toBe("PENDING");

  const r2 = await submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "x" }, intake: {} });
  expect(r2.passed).toBe(false);
  expect(r2.attemptsUsed).toBe(2);
  expect(r2.locked).toBe(true);
  const locked = await prisma.training.findUniqueOrThrow({ where: { personId_termId_track: { personId: vol.id, termId: term.id, track: "VOLUNTEER" } } });
  expect(locked.locked).toBe(true);

  await expect(submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: {} })).rejects.toBeInstanceOf(QuizLockedError);

  await resetTraining(vol.id, term.id, "VOLUNTEER", srr.id);
  const r3 = await submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: { feedback: "done" } });
  expect(r3.passed).toBe(true);
  const done = await prisma.training.findUniqueOrThrow({ where: { personId_termId_track: { personId: vol.id, termId: term.id, track: "VOLUNTEER" } } });
  expect(done.status).toBe("COMPLETE");
  expect(done.completedVia).toBe("QUIZ");
  expect(done.feedback).toBe("done");
  expect(await prisma.quizAttempt.count({ where: { training: { personId: vol.id, termId: term.id, track: "VOLUNTEER" } } })).toBe(3);
});

it("a quiz with one keyed and one unkeyed question returns a verdict only for the keyed one", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  await updateQuizSettings(c1.id, { quizPassPercent: 100, quizMaxAttempts: 2, inPersonTrainingDate: null, trainingLocation: null }, srr.id);
  // seedMember's addQuiz already gave c1 a keyed q1/q2; unkey q2 in place
  // (rather than inserting a second quiz, which would collide on cycleId+key)
  // to get the partially-keyed case this test needs.
  await prisma.formField.update({ where: { cycleId_key: { cycleId: c1.id, key: "q2" } }, data: { correctValue: null } });
  // Add a third, keyed question and answer it wrong. Without this the fixture
  // (only q1 graded, answered correctly, passPercent 100) always PASSES, so it
  // never exercises the review-after-fail path this test is named for.
  const quizSection = await prisma.formSection.findFirstOrThrow({ where: { cycleId: c1.id, purpose: "QUIZ" } });
  await prisma.formField.create({
    data: {
      sectionId: quizSection.id, cycleId: c1.id, key: "q3", label: "Q3", type: "SINGLE_SELECT", order: 2,
      options: [{ value: "p", label: "P" }, { value: "q", label: "Q" }], correctValue: "p",
    },
  });

  const r = await submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "x", q3: "q" }, intake: {} });
  expect(r.passed).toBe(false);
  expect(r.verdictByKey).toEqual({ q1: "correct", q3: "wrong" });
  expect(r.verdictByKey.q2).toBeUndefined();
});

it("the submission payload contains no field holding a correct option value", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  await updateQuizSettings(c1.id, { quizPassPercent: 100, quizMaxAttempts: 2, inPersonTrainingDate: null, trainingLocation: null }, srr.id);

  const r = await submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "x" }, intake: {} });
  const serialized = JSON.stringify(r);
  expect(serialized).not.toContain('"correctValue"');
  // Known correct answers for q1 ("a") and q2 ("y"). Checking the serialized shape
  // (not just property names) so a future field can't reintroduce the leak under a
  // different name.
  expect(serialized).not.toContain('"a"');
  expect(serialized).not.toContain('"y"');
});

it("submitQuiz throws when every question is unkeyed, not only when there are none", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  await updateQuizSettings(c1.id, { quizPassPercent: 100, quizMaxAttempts: 2, inPersonTrainingDate: null, trainingLocation: null }, srr.id);
  // seedMember's quiz has real questions (q1, q2); strip both answer keys so the
  // quiz is unpassable despite having a non-empty questions array. A cycle whose
  // designation predates this guard (or whose keys were later cleared) must still
  // block submission, not just a cycle with zero questions.
  await prisma.formField.updateMany({ where: { cycleId: c1.id }, data: { correctValue: null } });

  await expect(
    submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: {} }),
  ).rejects.toBeInstanceOf(TrainingStateError);
});

it("does not reset a member whose training is already COMPLETE", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  // Reach COMPLETE via attendance, then confirm resetTraining leaves the row untouched
  // (its updateMany filters on status: { not: "COMPLETE" }).
  await completeTraining(prisma, { personId: vol.id, termId: term.id, cycleId: c1.id, track: "VOLUNTEER", via: "ATTENDANCE", actorId: srr.id });
  const before = await prisma.training.findUniqueOrThrow({ where: { personId_termId_track: { personId: vol.id, termId: term.id, track: "VOLUNTEER" } } });
  expect(before.status).toBe("COMPLETE");
  expect(before.lockResetAt).toBeNull();

  await resetTraining(vol.id, term.id, "VOLUNTEER", srr.id);

  const after = await prisma.training.findUniqueOrThrow({ where: { personId_termId_track: { personId: vol.id, termId: term.id, track: "VOLUNTEER" } } });
  expect(after.status).toBe("COMPLETE");
  expect(after.lockResetAt).toBeNull();
  expect(after.completedAt?.getTime()).toBe(before.completedAt?.getTime());
});

it("getMyTraining returns the cycle, questions, and state for the volunteer", async () => {
  const { vol } = await seedMember();
  const trainings = await getMyTraining(vol.id);
  const my = trainings[0]!;
  expect(my.state).toBe("PENDING");
  expect(my.locked).toBe(false);
  expect(my.questions.map((q) => q.key)).toEqual(["q1", "q2"]);

  // getMyTrainingForTerm now selects correctValue so it can count keyed
  // questions (gradedQuestionCount), and my.questions is passed straight into a
  // client component. The hand-written map that strips correctValue is the only
  // thing keeping it off the wire, so assert on the serialized payload, not just
  // the type, the way the sibling submitQuiz test does.
  const serialized = JSON.stringify(my.questions);
  expect(serialized).not.toContain("correctValue");
  // Known correct answers from addQuiz: q1 -> "a", q2 -> "y". Unlike the
  // submitQuiz payload, this one legitimately carries "a"/"y" once each already
  // (they are valid option values, not secrets), so check the count rather than
  // mere absence: a leak under a different field name would make either value
  // appear a SECOND time alongside its own option.
  expect(serialized.match(/"a"/g)?.length).toBe(1);
  expect(serialized.match(/"y"/g)?.length).toBe(1);
});

it("gates the makeup quiz until the day after the in-person training date", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  // Set an in-person date in the future -> makeup not open yet.
  const future = new Date(Date.now() + 7 * 86_400_000);
  await updateQuizSettings(c1.id, { quizPassPercent: 100, quizMaxAttempts: 3, inPersonTrainingDate: future, trainingLocation: null }, srr.id);

  const beforeOpen = await getMyTraining(vol.id);
  expect(beforeOpen[0]!.inPersonTrainingDate?.getTime()).toBe(future.getTime());
  expect(beforeOpen[0]!.makeupOpen).toBe(false);

  await expect(
    submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: {} }),
  ).rejects.toBeInstanceOf(TrainingStateError);

  // Move the date to the past -> makeup open, submission works.
  const past = new Date(Date.now() - 2 * 86_400_000);
  await updateQuizSettings(c1.id, { quizPassPercent: 100, quizMaxAttempts: 3, inPersonTrainingDate: past, trainingLocation: null }, srr.id);
  const afterOpen = await getMyTraining(vol.id);
  expect(afterOpen[0]!.makeupOpen).toBe(true);
  const r = await submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: {} });
  expect(r.passed).toBe(true);
});

it("makeupOpen is true and submit works when no in-person date is set (backward compatible)", async () => {
  const { term, vol } = await seedMember();
  const my = await getMyTraining(vol.id);
  expect(my[0]!.inPersonTrainingDate).toBeNull();
  expect(my[0]!.makeupOpen).toBe(true);
  const r = await submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: {} });
  expect(r.passed).toBe(true);
});

it("submitQuiz rejects when already complete", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  await completeTraining(prisma, { personId: vol.id, termId: term.id, cycleId: c1.id, track: "VOLUNTEER", via: "ATTENDANCE", actorId: srr.id });
  await expect(submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: {} })).rejects.toBeInstanceOf(TrainingStateError);
});

it("listTrainingRoster lists in-scope active volunteers with cert + training state", async () => {
  const { srr, vol, c1, dept } = await seedMember();
  await prisma.hipaaCertificate.create({ data: { personId: vol.id, fileName: "c.pdf", storedName: "c.pdf", size: 1, mimeType: "application/pdf", completionDate: new Date(), verifiedAt: new Date() } });
  const rows = await listTrainingRoster(c1.id, srr.id);
  const row = memberRow(rows, vol.id);
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
  await addQuiz(c1.id);
  await addQuiz(dirCycle.id);
  await setTrainingCycle(c1.id, true, srr.id);        // volunteer
  await setTrainingCycle(dirCycle.id, true, srr.id);  // director
  expect((await getTrainingCycleForTerm(term.id, "VOLUNTEER"))?.id).toBe(c1.id);
  expect((await getTrainingCycleForTerm(term.id, "DIRECTOR"))?.id).toBe(dirCycle.id);
});

it("designating a second cycle of a track clears the first of that track only", async () => {
  const { srr, term, c1, c2 } = await seed();
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await addQuiz(c1.id);
  await addQuiz(dirCycle.id);
  await addQuiz(c2.id);
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
  await addQuiz(dirCycle.id);
  await setTrainingCycle(dirCycle.id, true, srr.id);
  // director-only now -> [DIRECTOR]
  expect(await requiredTrainingTracks(dir.id, term.id)).toEqual(["DIRECTOR"]);
});

it("requiredTrainingTracks returns both tracks for a director+volunteer when both cycles run", async () => {
  const { term, srr, vol, dept } = await seedMember();
  await prisma.termMembership.create({ data: { personId: vol.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await addQuiz(dirCycle.id);
  await setTrainingCycle(dirCycle.id, true, srr.id);
  expect(await requiredTrainingTracks(vol.id, term.id)).toEqual(["VOLUNTEER", "DIRECTOR"]);
});

it("a director completes director training via the quiz", async () => {
  const { term, srr, dir } = await seedMember();
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await addQuiz(dirCycle.id);
  await setTrainingCycle(dirCycle.id, true, srr.id);
  await updateQuizSettings(dirCycle.id, { quizPassPercent: 100, quizMaxAttempts: 2, inPersonTrainingDate: null, trainingLocation: null }, srr.id);

  const r = await submitQuiz(dir.id, { termId: term.id, track: "DIRECTOR", answers: { q1: "a", q2: "y" }, intake: {} });
  expect(r.passed).toBe(true);
  expect(await resolveTrainingState(dir.id, term.id, "DIRECTOR")).toBe("COMPLETE");
  // their (nonexistent) volunteer training is untouched
  expect(await resolveTrainingState(dir.id, term.id, "VOLUNTEER")).toBe("PENDING");
});

it("submitQuiz rejects a track the person has no active membership for", async () => {
  const { term, srr, vol } = await seedMember();
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await addQuiz(dirCycle.id);
  await setTrainingCycle(dirCycle.id, true, srr.id);
  await expect(submitQuiz(vol.id, { termId: term.id, track: "DIRECTOR", answers: { q1: "a", q2: "y" }, intake: {} }))
    .rejects.toBeInstanceOf(TrainingStateError); // vol is not an active director
});

it("submitQuiz completes NEXT-term training while a different term is live", async () => {
  const { srr, vol, dept } = await seedMember(); // live term SU26 is ACTIVE
  const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING" } });
  const nextCycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: next.id, title: "FA vol", publicSlug: "fa-vol", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await addQuiz(nextCycle.id);
  await setTrainingCycle(nextCycle.id, true, srr.id);
  await updateQuizSettings(nextCycle.id, { quizPassPercent: 100, quizMaxAttempts: 2, inPersonTrainingDate: null, trainingLocation: null }, srr.id);
  await prisma.termMembership.create({ data: { personId: vol.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });

  const r = await submitQuiz(vol.id, { termId: next.id, track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: {} });
  expect(r.passed).toBe(true);
  expect(await resolveTrainingState(vol.id, next.id, "VOLUNTEER")).toBe("COMPLETE");
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
  await addQuiz(dirCycle.id);
  await setTrainingCycle(dirCycle.id, true, srr.id);
  const both = await getMyTraining(vol.id);
  expect(both.map((m) => m.track)).toEqual(["VOLUNTEER", "DIRECTOR"]);
  expect(both.map((m) => m.trackLabel)).toEqual(["Volunteer training", "Director training"]);
});

it("getMyTraining is empty for a director-only person with no director cycle", async () => {
  const { dir } = await seedMember();
  expect(await getMyTraining(dir.id)).toEqual([]);
});

it("getMyTraining spans the person's live and next terms, live first", async () => {
  const { srr, vol, dept } = await seedMember(); // live term SU26 with designated volunteer cycle c1; vol is an active volunteer
  // Build a next (PLANNING) term with its own designated volunteer training cycle + membership for vol.
  const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING" } });
  const nextCycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: next.id, title: "FA vol", publicSlug: "fa-vol", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await addQuiz(nextCycle.id);
  await setTrainingCycle(nextCycle.id, true, srr.id);
  await prisma.termMembership.create({ data: { personId: vol.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });

  const trainings = await getMyTraining(vol.id);
  expect(trainings.map((m) => m.term.name)).toEqual(["Summer", "Fall"]);
  expect(trainings.every((m) => m.track === "VOLUNTEER")).toBe(true);
});

it("listTrainingRoster for a DIRECTOR cycle lists directors not volunteers", async () => {
  const { term, srr, vol, dir } = await seedMember();
  const dirCycle = await prisma.recruitmentCycle.create({
    data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" },
  });
  await addQuiz(dirCycle.id);
  await setTrainingCycle(dirCycle.id, true, srr.id);

  const rows = await listTrainingRoster(dirCycle.id, srr.id);
  const ids = memberIds(rows);
  expect(ids).toContain(dir.id);
  expect(ids).not.toContain(vol.id);
  const dirRow = memberRow(rows, dir.id);
  expect(dirRow.trainingState).toBe("PENDING");
});

// ---------------------------------------------------------------------------
// Absence excuses
// ---------------------------------------------------------------------------

it("records an excuse the roster shows, without completing training", async () => {
  const { srr, vol, c1 } = await seedMember();
  await recordAbsenceExcuse(c1.id, vol.id, "  Has an exam that night  ", srr.id);

  const row = memberRow(await listTrainingRoster(c1.id, srr.id), vol.id);
  expect(row.excuse?.reason).toBe("Has an exam that night");
  expect(row.excuse?.recordedByName).toBe("SRR");
  // The whole of "record only": being excused is not being trained.
  expect(row.trainingState).toBe("PENDING");
});

it("re-recording an excuse edits the reason instead of stacking rows", async () => {
  const { srr, vol, c1 } = await seedMember();
  await recordAbsenceExcuse(c1.id, vol.id, "Exam", srr.id);
  await recordAbsenceExcuse(c1.id, vol.id, "Family emergency", srr.id);

  expect(await prisma.trainingAbsenceExcuse.count({ where: { cycleId: c1.id, personId: vol.id } })).toBe(1);
  const row = memberRow(await listTrainingRoster(c1.id, srr.id), vol.id);
  expect(row.excuse?.reason).toBe("Family emergency");
});

it("refuses a blank reason: an excuse with no reason is just an absence", async () => {
  const { srr, vol, c1 } = await seedMember();
  await expect(recordAbsenceExcuse(c1.id, vol.id, "   ", srr.id)).rejects.toBeInstanceOf(TrainingStateError);
  expect(await prisma.trainingAbsenceExcuse.count()).toBe(0);
});

it("requires manage_cycles to excuse or to clear an excuse", async () => {
  const { srr, plain, vol, c1 } = await seedMember();
  await expect(recordAbsenceExcuse(c1.id, vol.id, "Exam", plain.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
  await recordAbsenceExcuse(c1.id, vol.id, "Exam", srr.id);
  await expect(clearAbsenceExcuse(c1.id, vol.id, plain.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
  expect(await prisma.trainingAbsenceExcuse.count()).toBe(1);
});

it("refuses someone who is not on the cycle's roster", async () => {
  const { srr, dir, plain, c1 } = await seedMember();
  // No membership at all.
  await expect(recordAbsenceExcuse(c1.id, plain.id, "Exam", srr.id)).rejects.toBeInstanceOf(TrainingStateError);
  // A member of the term, but of the wrong track for this cycle.
  await expect(recordAbsenceExcuse(c1.id, dir.id, "Exam", srr.id)).rejects.toBeInstanceOf(TrainingStateError);
  expect(await prisma.trainingAbsenceExcuse.count()).toBe(0);
});

it("clearing an excuse removes it, and clearing twice is not an error", async () => {
  const { srr, vol, c1 } = await seedMember();
  await recordAbsenceExcuse(c1.id, vol.id, "Exam", srr.id);
  await clearAbsenceExcuse(c1.id, vol.id, srr.id);
  await clearAbsenceExcuse(c1.id, vol.id, srr.id);

  expect(await prisma.trainingAbsenceExcuse.count()).toBe(0);
  const row = memberRow(await listTrainingRoster(c1.id, srr.id), vol.id);
  expect(row.excuse).toBeNull();
});

it("keeps the excuse on the roster after training completes by makeup quiz", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  await recordAbsenceExcuse(c1.id, vol.id, "Exam", srr.id);
  const result = await submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: {} });
  expect(result.passed).toBe(true);

  const row = memberRow(await listTrainingRoster(c1.id, srr.id), vol.id);
  expect(row.trainingState).toBe("COMPLETE");
  expect(row.excuse?.reason).toBe("Exam");
});

// ---------------------------------------------------------------------------
// Excuses entered from an applicant's profile, before they are on any roster
// ---------------------------------------------------------------------------

/** An applicant of `cycleId`, optionally already linked to a hub account. */
async function seedApplicant(cycleId: string, email: string, personId?: string) {
  return prisma.applicant.create({
    data: {
      cycleId,
      firstName: "App",
      lastName: "Licant",
      email,
      emailLower: email.toLowerCase(),
      ...(personId ? { applicantPersonId: personId } : {}),
    },
  });
}

/** Accept an applicant into a department, with no contract and so no promotion. */
async function acceptApplicant(
  applicantId: string,
  cycleId: string,
  approverId: string,
  deptCode = "SRHD",
  applicantType: ApplicantType = "NEW",
) {
  const application = await prisma.application.create({
    data: { cycleId, applicantId, answers: {}, applicantType, departmentChoices: [deptCode] },
  });
  return prisma.acceptance.create({
    data: { applicationId: application.id, departmentCode: deptCode, approvedById: approverId },
  });
}

// ---------------------------------------------------------------------------
// The roster's second half: accepted, not yet onboarded
// ---------------------------------------------------------------------------

it("lists accepted applicants who have no account yet", async () => {
  const { srr, c1, vol } = await seedMember();
  const applicant = await seedApplicant(c1.id, "ada@yale.edu");
  const acceptance = await acceptApplicant(applicant.id, c1.id, srr.id);

  const rows = await listTrainingRoster(c1.id, srr.id);
  const row = rows.find((r) => r.name === "App Licant");
  expect(row).toBeDefined();
  expect(row?.kind).toBe("applicant");
  if (row?.kind !== "applicant") throw new Error("expected an applicant row");
  expect(row.acceptanceId).toBe(acceptance.id);
  expect(row.applicantId).toBe(applicant.id);
  expect(row.departmentCode).toBe("SRHD");
  expect(row.trainingState).toBe("PENDING");
  // No Person means no certificate can exist for them yet, and the contract that
  // would put them on the roster is the thing still outstanding.
  expect(row.certStatus).toBe("NO_CERTIFICATE");
  // Its own state, NOT the failure one a member gets: nothing has been checked
  // and found wanting, there is nothing to check yet. See clearanceLabel.
  expect(row.overallClearance).toBe("NOT_ONBOARDED");
  expect(row.locked).toBe(false);

  // The membership half is untouched and the two interleave by name.
  expect(memberRow(rows, vol.id).kind).toBe("member");
});

it("reads an accepted applicant's training state off their attendance row", async () => {
  // completeTraining is keyed on personId, which they do not have, so the
  // EventAttendance row IS the record until promotion converts it.
  const { term, srr, c1 } = await seedMember();
  const applicant = await seedApplicant(c1.id, "ada@yale.edu");
  await acceptApplicant(applicant.id, c1.id, srr.id);
  const event = await prisma.attendanceEvent.create({
    data: { termId: term.id, cycleId: c1.id, kind: "TRAINING", title: "T", startsAt: new Date() },
  });
  await prisma.eventAttendance.create({
    data: { eventId: event.id, attendeeName: "App Licant", attendeeEmail: "ada@yale.edu", method: "WALK_UP" },
  });

  const row = (await listTrainingRoster(c1.id, srr.id)).find((r) => r.kind === "applicant");
  expect(row?.trainingState).toBe("COMPLETE");
  // Attending does not clear them: the contract is still outstanding.
  expect(row?.overallClearance).toBe("NOT_ONBOARDED");
});

it("drops an accepted applicant from the roster once promotion gives them a membership", async () => {
  const { srr, c1, vol } = await seedMember();
  // Same human as the seeded member: accepted, and since promoted.
  const applicant = await seedApplicant(c1.id, "vol@yale.edu");
  const acceptance = await acceptApplicant(applicant.id, c1.id, srr.id);
  await prisma.person.update({ where: { id: vol.id }, data: { contactEmail: "vol@yale.edu" } });
  await prisma.onboardingContract.create({
    data: {
      acceptanceId: acceptance.id,
      token: "tok-roster",
      email: "vol@yale.edu",
      firstName: "App",
      lastName: "Licant",
      promotedPersonId: vol.id,
    },
  });

  const rows = await listTrainingRoster(c1.id, srr.id);
  expect(rows.filter((r) => r.kind === "applicant")).toHaveLength(0);
  expect(memberRow(rows, vol.id)).toBeDefined();
});

it("shows an applicant excuse on the roster, under the email it was stored with", async () => {
  const { srr, c1 } = await seedMember();
  const applicant = await seedApplicant(c1.id, "ada@yale.edu");
  await acceptApplicant(applicant.id, c1.id, srr.id);
  await recordApplicantAbsenceExcuse(c1.id, applicant.id, "Exam that night", srr.id);

  const row = (await listTrainingRoster(c1.id, srr.id)).find((r) => r.kind === "applicant");
  expect(row?.excuse?.reason).toBe("Exam that night");
});

it("shows an applicant excuse filed against the account they already have", async () => {
  // recordApplicantAbsenceExcuse PREFERS the linked account, so in a
  // renewal-heavy cycle almost every excuse is stored person-keyed. The roster
  // read the applicant half by email alone and showed none of them.
  const { srr, c1 } = await seedMember();
  const returning = await prisma.person.create({
    data: { name: "Re Turning", status: "ACTIVE", contactEmail: "ada@yale.edu" },
  });
  const applicant = await seedApplicant(c1.id, "ada@yale.edu", returning.id);
  await acceptApplicant(applicant.id, c1.id, srr.id, "SRHD", "RENEWAL");
  await recordApplicantAbsenceExcuse(c1.id, applicant.id, "Sister's wedding", srr.id);
  // Person-keyed, which is the half the roster could not see.
  expect(
    await prisma.trainingAbsenceExcuse.findFirst({ where: { cycleId: c1.id, personId: returning.id } }),
  ).not.toBeNull();

  const row = applicantRow(await listTrainingRoster(c1.id, srr.id));
  expect(row?.excuse?.reason).toBe("Sister's wedding");
});

it("shows an applicant excuse filed against an account matched only by email", async () => {
  const { srr, c1 } = await seedMember();
  await prisma.person.create({
    data: { name: "Re Turning", status: "ACTIVE", contactEmail: "Ada@Yale.edu" },
  });
  const applicant = await seedApplicant(c1.id, "ada@yale.edu");
  await acceptApplicant(applicant.id, c1.id, srr.id, "SRHD", "RENEWAL");
  await recordApplicantAbsenceExcuse(c1.id, applicant.id, "Away that weekend", srr.id);

  expect(applicantRow(await listTrainingRoster(c1.id, srr.id))?.excuse?.reason).toBe(
    "Away that weekend",
  );
});

it("scopes accepted applicants to a director's own departments", async () => {
  const { term, srr, c1 } = await seedMember();
  const other = await prisma.department.create({ data: { code: "INTP", name: "Interpreting" } });
  // A director of INTP only: a review scope, no clinic-wide recruitment grant.
  const director = await prisma.person.create({ data: { name: "IntpDir", status: "ACTIVE" } });
  await prisma.termMembership.create({
    data: { personId: director.id, termId: term.id, departmentId: other.id, kind: "DIRECTOR", status: "ACTIVE" },
  });
  const mine = await seedApplicant(c1.id, "mine@yale.edu");
  await acceptApplicant(mine.id, c1.id, srr.id, "INTP");
  const theirs = await prisma.applicant.create({
    data: { cycleId: c1.id, firstName: "Not", lastName: "Mine", email: "theirs@yale.edu", emailLower: "theirs@yale.edu" },
  });
  await acceptApplicant(theirs.id, c1.id, srr.id, "SRHD");

  const names = (await listTrainingRoster(c1.id, director.id)).map((r) => r.name);
  expect(names).toContain("App Licant");
  expect(names).not.toContain("Not Mine");
});

it("excuses an applicant with no hub account, keyed on their email", async () => {
  const { srr, c1 } = await seedMember();
  const applicant = await seedApplicant(c1.id, "Newbie@Yale.edu");

  await recordApplicantAbsenceExcuse(c1.id, applicant.id, "Exam that night", srr.id);

  const excuse = await getApplicantAbsenceExcuse(c1.id, applicant.id);
  expect(excuse?.reason).toBe("Exam that night");
  // The applicant profile says so, to explain why it is not on the roster yet.
  expect(excuse?.unlinked).toBe(true);
  const row = await prisma.trainingAbsenceExcuse.findFirstOrThrow();
  expect(row.personId).toBeNull();
  expect(row.emailLower).toBe("newbie@yale.edu");
});

// The sequence this whole shape exists for: excused in October as an applicant,
// promoted in November, and the roster that judges them in December has to know.
it("an email-keyed excuse reaches the training roster once that person exists", async () => {
  const { term, srr, c1, dept } = await seedMember();
  const applicant = await seedApplicant(c1.id, "later@yale.edu");
  await recordApplicantAbsenceExcuse(c1.id, applicant.id, "Away at a conference", srr.id);

  // Promotion, in the only part that matters here: a Person with that address,
  // on the cycle's roster.
  const promoted = await prisma.person.create({
    data: { name: "Later Arrival", status: "ACTIVE", contactEmail: "later@yale.edu" },
  });
  await prisma.termMembership.create({
    data: { personId: promoted.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });

  const row = memberRow(await listTrainingRoster(c1.id, srr.id), promoted.id);
  expect(row.excuse?.reason).toBe("Away at a conference");
  expect(row.excuse?.unlinked).toBe(true);
});

it("stores a personId when the applicant is already linked to an account", async () => {
  const { srr, vol, c1 } = await seedMember();
  const applicant = await seedApplicant(c1.id, "vol@yale.edu", vol.id);

  await recordApplicantAbsenceExcuse(c1.id, applicant.id, "Exam", srr.id);

  const stored = await prisma.trainingAbsenceExcuse.findFirstOrThrow();
  expect(stored.personId).toBe(vol.id);
  expect(stored.emailLower).toBeNull();
  // So it is on the roster straight away, not waiting to be matched.
  const row = memberRow(await listTrainingRoster(c1.id, srr.id), vol.id);
  expect(row.excuse?.reason).toBe("Exam");
  expect(row.excuse?.unlinked).toBe(false);
});

// applicantPersonId is only set for signed-in renewals and promotion never
// backfills it, so matching on the address is the common path, not a fallback.
it("stores a personId when only the email matches an existing account", async () => {
  const { srr, vol, c1 } = await seedMember();
  await prisma.person.update({ where: { id: vol.id }, data: { contactEmail: "vol@yale.edu" } });
  const applicant = await seedApplicant(c1.id, "VOL@yale.edu");

  await recordApplicantAbsenceExcuse(c1.id, applicant.id, "Exam", srr.id);

  const stored = await prisma.trainingAbsenceExcuse.findFirstOrThrow();
  expect(stored.personId).toBe(vol.id);
});

// The state the hub is actually in: excuses that reached the table under the
// email key, for applicants who since turned out to have an account. Every read
// has to cope, or the two pages tell a lead different things about the same row.
it("finds an email-keyed excuse for an applicant who does have an account", async () => {
  const { srr, vol, c1 } = await seedMember();
  await prisma.person.update({ where: { id: vol.id }, data: { contactEmail: "vol@yale.edu" } });
  const applicant = await seedApplicant(c1.id, "vol@yale.edu", vol.id);
  // Filed under the email, as an import or a pre-account write leaves it.
  await prisma.trainingAbsenceExcuse.create({
    data: { cycleId: c1.id, emailLower: "vol@yale.edu", reason: "Booked travel", recordedById: srr.id },
  });

  expect((await getApplicantAbsenceExcuse(c1.id, applicant.id))?.reason).toBe("Booked travel");
});

it("clearing an applicant's excuse takes the row under the other key with it", async () => {
  const { srr, vol, c1 } = await seedMember();
  await prisma.person.update({ where: { id: vol.id }, data: { contactEmail: "vol@yale.edu" } });
  const applicant = await seedApplicant(c1.id, "vol@yale.edu", vol.id);
  await prisma.trainingAbsenceExcuse.create({
    data: { cycleId: c1.id, emailLower: "vol@yale.edu", reason: "Booked travel", recordedById: srr.id },
  });

  await clearApplicantAbsenceExcuse(c1.id, applicant.id, srr.id);

  // Left behind, the excuse came back on the next render of a page that had
  // just said it was gone.
  expect(await prisma.trainingAbsenceExcuse.count()).toBe(0);
  expect(await getApplicantAbsenceExcuse(c1.id, applicant.id)).toBeNull();
});

it("re-excusing an applicant leaves one row, not one per key", async () => {
  const { srr, vol, c1 } = await seedMember();
  await prisma.person.update({ where: { id: vol.id }, data: { contactEmail: "vol@yale.edu" } });
  const applicant = await seedApplicant(c1.id, "vol@yale.edu", vol.id);
  await prisma.trainingAbsenceExcuse.create({
    data: { cycleId: c1.id, emailLower: "vol@yale.edu", reason: "Booked travel", recordedById: srr.id },
  });

  await recordApplicantAbsenceExcuse(c1.id, applicant.id, "Family wedding", srr.id);

  const rows = await prisma.trainingAbsenceExcuse.findMany();
  expect(rows).toHaveLength(1);
  expect(rows[0].personId).toBe(vol.id);
  expect(rows[0].reason).toBe("Family wedding");
});

it("refuses an applicant belonging to a different cycle", async () => {
  const { srr, c1, c2 } = await seedMember();
  const applicant = await seedApplicant(c2.id, "elsewhere@yale.edu");
  await expect(recordApplicantAbsenceExcuse(c1.id, applicant.id, "Exam", srr.id)).rejects.toBeInstanceOf(TrainingStateError);
  expect(await prisma.trainingAbsenceExcuse.count()).toBe(0);
});

it("requires manage_cycles to excuse an applicant", async () => {
  const { plain, c1 } = await seedMember();
  const applicant = await seedApplicant(c1.id, "newbie@yale.edu");
  await expect(recordApplicantAbsenceExcuse(c1.id, applicant.id, "Exam", plain.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
  expect(await prisma.trainingAbsenceExcuse.count()).toBe(0);
});

it("clears an applicant's excuse whichever key it was stored under", async () => {
  const { srr, vol, c1 } = await seedMember();
  const unlinked = await seedApplicant(c1.id, "newbie@yale.edu");
  const linked = await seedApplicant(c1.id, "vol@yale.edu", vol.id);
  await recordApplicantAbsenceExcuse(c1.id, unlinked.id, "Exam", srr.id);
  await recordApplicantAbsenceExcuse(c1.id, linked.id, "Exam", srr.id);
  expect(await prisma.trainingAbsenceExcuse.count()).toBe(2);

  await clearApplicantAbsenceExcuse(c1.id, unlinked.id, srr.id);
  await clearApplicantAbsenceExcuse(c1.id, linked.id, srr.id);

  expect(await prisma.trainingAbsenceExcuse.count()).toBe(0);
  expect(await getApplicantAbsenceExcuse(c1.id, unlinked.id)).toBeNull();
});

// Both keys can coexist when an old applicant-era row outlives promotion and a
// lead then excuses the member they became. The roster must not show the stale one.
it("prefers the person-keyed excuse over an older email-keyed row", async () => {
  const { term, srr, c1, dept } = await seedMember();
  const applicant = await seedApplicant(c1.id, "both@yale.edu");
  await recordApplicantAbsenceExcuse(c1.id, applicant.id, "Old reason", srr.id);

  const promoted = await prisma.person.create({
    data: { name: "Both Keys", status: "ACTIVE", contactEmail: "both@yale.edu" },
  });
  await prisma.termMembership.create({
    data: { personId: promoted.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  await recordAbsenceExcuse(c1.id, promoted.id, "Current reason", srr.id);

  expect(await prisma.trainingAbsenceExcuse.count()).toBe(2);
  const row = memberRow(await listTrainingRoster(c1.id, srr.id), promoted.id);
  expect(row.excuse?.reason).toBe("Current reason");
});

it("an excuse on one cycle does not leak onto another cycle's roster", async () => {
  const { srr, vol, c1, c2 } = await seedMember();
  await recordAbsenceExcuse(c1.id, vol.id, "Exam", srr.id);
  await setTrainingCycle(c1.id, false, srr.id);
  await addQuiz(c2.id);
  await setTrainingCycle(c2.id, true, srr.id);

  const row = memberRow(await listTrainingRoster(c2.id, srr.id), vol.id);
  expect(row.excuse).toBeNull();
});

// ---------------------------------------------------------------------------
// The Cert column, before anybody has been promoted
//
// A training session happens in the window where most of the roster is accepted
// and not yet onboarded, so "no Person, therefore no certificate" left the
// column saying nothing on exactly the day it is read. By then the certificate
// is on the contract; these pin that it is read from there, on the same rules.
// ---------------------------------------------------------------------------

/** A contract against an acceptance, carrying whatever HIPAA columns the test needs. */
async function seedContract(
  acceptanceId: string,
  hipaa: { storedName?: string; completedAt?: Date } = {},
) {
  return prisma.onboardingContract.create({
    data: {
      acceptanceId,
      token: `tok-${acceptanceId}`,
      email: "ada@yale.edu",
      firstName: "App",
      lastName: "Licant",
      hipaaStoredName: hipaa.storedName ?? null,
      hipaaFileName: hipaa.storedName ? "hipaa.pdf" : null,
      hipaaCompletedAt: hipaa.completedAt ?? null,
    },
  });
}

/** The roster's single accepted-not-promoted row. */
function applicantRow(rows: TrainingRosterRow[]) {
  return rows.find((r) => r.kind === "applicant");
}

it("reads an accepted applicant's certificate off their onboarding contract", async () => {
  const { srr, c1 } = await seedMember();
  const applicant = await seedApplicant(c1.id, "ada@yale.edu");
  const acceptance = await acceptApplicant(applicant.id, c1.id, srr.id);
  // What submitContract writes: the file, and the completion date it requires
  // beside it. Dated today, so expiry is not what is under test.
  await seedContract(acceptance.id, { storedName: "hipaa-1.pdf", completedAt: new Date() });

  const row = applicantRow(await listTrainingRoster(c1.id, srr.id));
  // Not COMPLIANT. Promotion writes this same certificate unverified, so an
  // applicant must not read as more cleared than the member they become.
  expect(row?.certStatus).toBe("PENDING_VERIFICATION");
  // And it clears nobody by itself: the contract is still the outstanding thing.
  expect(row?.overallClearance).toBe("NOT_ONBOARDED");
});

it("leaves an applicant at NO_CERTIFICATE while the contract is unsubmitted", async () => {
  const { srr, c1 } = await seedMember();
  const applicant = await seedApplicant(c1.id, "ada@yale.edu");
  const acceptance = await acceptApplicant(applicant.id, c1.id, srr.id);
  // Sent, not filled in: submitContract is what writes the hipaa columns, so
  // the honest answer here is the one this column always gave.
  await seedContract(acceptance.id);

  expect(applicantRow(await listTrainingRoster(c1.id, srr.id))?.certStatus).toBe("NO_CERTIFICATE");
});

it("reads a dateless contract certificate as UNKNOWN_DATE, not as none at all", async () => {
  const { srr, c1 } = await seedMember();
  const applicant = await seedApplicant(c1.id, "ada@yale.edu");
  const acceptance = await acceptApplicant(applicant.id, c1.id, srr.id);
  await seedContract(acceptance.id, { storedName: "hipaa-1.pdf" });

  expect(applicantRow(await listTrainingRoster(c1.id, srr.id))?.certStatus).toBe("UNKNOWN_DATE");
});

/** A certificate on a Person, the way an earlier term left it. */
async function seedCert(
  personId: string,
  cert: { completionDate?: Date | null; verified?: boolean; uploadedAt?: Date } = {},
) {
  return prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "hipaa.pdf",
      storedName: `cert-${personId}-${cert.uploadedAt?.getTime() ?? 0}.pdf`,
      size: 1,
      mimeType: "application/pdf",
      completionDate: cert.completionDate ?? new Date(),
      verifiedAt: cert.verified === false ? null : new Date(),
      ...(cert.uploadedAt ? { uploadedAt: cert.uploadedAt } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// The Cert column for a returning volunteer, who has an account already
// ---------------------------------------------------------------------------

it("reads a returning applicant's certificate off the account they already have", async () => {
  // The renewal-heavy case the column was wrong about: a volunteer who signed in
  // to renew has a Person and a verified certificate, and their contract is the
  // thing still outstanding. Reading only the contract said NO_CERTIFICATE about
  // a document the clinic is holding.
  const { srr, c1 } = await seedMember();
  const returning = await prisma.person.create({
    data: { name: "Re Turning", status: "ACTIVE", contactEmail: "ada@yale.edu" },
  });
  await seedCert(returning.id);
  const applicant = await seedApplicant(c1.id, "ada@yale.edu", returning.id);
  await acceptApplicant(applicant.id, c1.id, srr.id, "SRHD", "RENEWAL");

  const row = applicantRow(await listTrainingRoster(c1.id, srr.id));
  expect(row?.certStatus).toBe("COMPLIANT");
  // Still not cleared: the contract is outstanding whatever the certificate says.
  expect(row?.overallClearance).toBe("NOT_ONBOARDED");
});

it("finds that account by email when the applicant never signed in to renew", async () => {
  // applicantPersonId is only ever set for a signed-in renewal, so the email
  // match is the path most returning applicants actually take.
  const { srr, c1 } = await seedMember();
  const returning = await prisma.person.create({
    data: { name: "Re Turning", status: "ACTIVE", contactEmail: "Ada@Yale.edu" },
  });
  await seedCert(returning.id);
  const applicant = await seedApplicant(c1.id, "ada@yale.edu");
  await acceptApplicant(applicant.id, c1.id, srr.id, "SRHD", "RENEWAL");

  expect(applicantRow(await listTrainingRoster(c1.id, srr.id))?.certStatus).toBe("COMPLIANT");
});

it("keeps a returning applicant cleared while their contract upload awaits verification", async () => {
  // Mid-renewal: the newest document is the unverified one they just attached to
  // the contract, and the verified one behind it is still valid. Reading only
  // the contract downgraded them to PENDING_VERIFICATION on the strength of an
  // upload that ADDED coverage.
  const { srr, c1 } = await seedMember();
  const returning = await prisma.person.create({
    data: { name: "Re Turning", status: "ACTIVE", contactEmail: "ada@yale.edu" },
  });
  await seedCert(returning.id);
  const applicant = await seedApplicant(c1.id, "ada@yale.edu", returning.id);
  const acceptance = await acceptApplicant(applicant.id, c1.id, srr.id, "SRHD", "RENEWAL");
  await seedContract(acceptance.id, { storedName: "hipaa-1.pdf", completedAt: new Date() });

  expect(applicantRow(await listTrainingRoster(c1.id, srr.id))?.certStatus).toBe("COMPLIANT");
});

it("still says NO_CERTIFICATE for a returning applicant whose account has none", async () => {
  const { srr, c1 } = await seedMember();
  const returning = await prisma.person.create({
    data: { name: "Re Turning", status: "ACTIVE", contactEmail: "ada@yale.edu" },
  });
  const applicant = await seedApplicant(c1.id, "ada@yale.edu", returning.id);
  await acceptApplicant(applicant.id, c1.id, srr.id, "SRHD", "RENEWAL");

  expect(applicantRow(await listTrainingRoster(c1.id, srr.id))?.certStatus).toBe("NO_CERTIFICATE");
});

it("reads a member's whole certificate history, not just the newest upload", async () => {
  // The same rule the clearance engine and the HIPAA panel apply
  // (effectiveCompliance): an early renewal awaiting verification must not
  // revoke the clearance the still-valid verified certificate underneath it
  // gives. The roster judged the newest row alone and disagreed with both.
  const { srr, c1, vol } = await seedMember();
  await seedCert(vol.id, { uploadedAt: new Date(Date.now() - 86_400_000) });
  await seedCert(vol.id, { verified: false, uploadedAt: new Date() });

  expect(memberRow(await listTrainingRoster(c1.id, srr.id), vol.id).certStatus).toBe("COMPLIANT");
});

// ---------------------------------------------------------------------------
// The Type column: has the clinic trained this person before?
// ---------------------------------------------------------------------------

it("carries the applicant's own answer onto the roster", async () => {
  const { srr, c1 } = await seedMember();
  const applicant = await seedApplicant(c1.id, "ada@yale.edu");
  await acceptApplicant(applicant.id, c1.id, srr.id, "SRHD", "TRANSFER");

  expect(applicantRow(await listTrainingRoster(c1.id, srr.id))?.origin).toBe("TRANSFER");
});

it("carries that answer through promotion, onto the member row", async () => {
  const { srr, vol, c1 } = await seedMember();
  const applicant = await seedApplicant(c1.id, "vol@yale.edu");
  const acceptance = await acceptApplicant(applicant.id, c1.id, srr.id, "SRHD", "RENEWAL");
  await prisma.onboardingContract.create({
    data: {
      acceptanceId: acceptance.id,
      token: "tok-promoted",
      email: "vol@yale.edu",
      firstName: "Vol",
      lastName: "Unteer",
      promotedPersonId: vol.id,
    },
  });

  // The applicant half drops them (they are promoted), and the member half now
  // says how they arrived rather than nothing at all.
  const rows = await listTrainingRoster(c1.id, srr.id);
  expect(rows.filter((r) => r.kind === "applicant")).toHaveLength(0);
  expect(memberRow(rows, vol.id).origin).toBe("RENEWAL");
});

it("reads a member carried over from a previous term as RETURNING", async () => {
  const { term, srr, vol, c1, dept } = await seedMember();
  // A roster copy writes the membership and no application, so the applicant
  // type has nothing to say about them. The previous term does.
  const lastTerm = await prisma.term.create({
    data: {
      code: "SP26",
      name: "Spring",
      startDate: new Date(term.startDate.getTime() - 180 * 24 * 60 * 60 * 1000),
      endDate: new Date(term.startDate.getTime() - 90 * 24 * 60 * 60 * 1000),
      status: "ARCHIVED",
    },
  });
  await prisma.termMembership.create({
    data: { personId: vol.id, termId: lastTerm.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });

  expect(memberRow(await listTrainingRoster(c1.id, srr.id), vol.id).origin).toBe("RETURNING");
});

it("says nothing about a member with no application and no previous term", async () => {
  const { srr, vol, c1 } = await seedMember();
  // Added to this term's roster by hand: the column has no source to answer
  // from, and inventing "New" for them would be a guess.
  expect(memberRow(await listTrainingRoster(c1.id, srr.id), vol.id).origin).toBeNull();
});
