import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("persists a Training row and a QuizAttempt, and enforces one training cycle per term", async () => {
  const term = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const c1 = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "A", publicSlug: "a", departments: [], createdById: srr.id, isTermTraining: true } });

  const training = await prisma.training.create({ data: { personId: srr.id, termId: term.id, cycleId: c1.id } });
  expect(training.status).toBe("PENDING");
  const attempt = await prisma.quizAttempt.create({ data: { trainingId: training.id, answers: {}, score: 0, total: 2, passed: false } });
  expect(attempt.passed).toBe(false);

  await expect(
    prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "B", publicSlug: "b", departments: [], createdById: srr.id, isTermTraining: true } })
  ).rejects.toMatchObject({ code: "P2002" });
});
