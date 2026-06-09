import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import {
  setTrainingCycle, getTrainingCycleForTerm, updateQuizSettings, TrainingStateError,
} from "./training";
import { recordAttendance, resolveTrainingState, completeTraining } from "./training";

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
  const row = await prisma.volunteerTraining.findUniqueOrThrow({ where: { personId_termId: { personId: vol.id, termId: term.id } } });
  expect(row.completedVia).toBe("ATTENDANCE");
  expect(row.attendanceRecordedById).toBe(srr.id);
  await recordAttendance(vol.id, term.id, srr.id);
  expect(await prisma.volunteerTraining.count({ where: { personId: vol.id, termId: term.id } })).toBe(1);
});

it("a director in scope can record attendance; an unrelated person cannot", async () => {
  const { term, vol, dir, plain } = await seedMember();
  await recordAttendance(vol.id, term.id, dir.id);
  expect(await resolveTrainingState(vol.id, term.id)).toBe("COMPLETE");
  await prisma.volunteerTraining.deleteMany({});
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
