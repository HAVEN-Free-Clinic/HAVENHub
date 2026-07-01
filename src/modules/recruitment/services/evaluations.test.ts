import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { createInterview, addPanelist } from "./interviews";
import { submitEvaluation } from "./evaluations";

async function seedInterview() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const educ = await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  const director = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: educ.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const panelist = await prisma.person.create({ data: { name: "Pan", status: "ACTIVE" } });
  const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["EDUC"], createdById: director.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "C", lastName: "I", email: "c@y.edu", emailLower: "c@y.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  const iv = await createInterview(application.id, "EDUC", director.id);
  await addPanelist(iv.id, panelist.id, false, director.id);
  return { iv, panelist, outsider };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("lets a panelist submit and update their evaluation (upsert)", async () => {
  const { iv, panelist } = await seedInterview();
  await submitEvaluation(iv.id, panelist.id, "YES", "solid");
  await submitEvaluation(iv.id, panelist.id, "STRONG_YES", "even better");
  const evals = await prisma.evaluation.findMany({ where: { interviewId: iv.id } });
  expect(evals).toHaveLength(1);
  expect(evals[0].recommendation).toBe("STRONG_YES");
  expect(evals[0].comments).toBe("even better");
});

it("rejects an evaluation from a non-panelist", async () => {
  const { iv, outsider } = await seedInterview();
  await expect(submitEvaluation(iv.id, outsider.id, "YES", null)).rejects.toBeInstanceOf(RecruitmentAuthError);
});
