import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { createInterview, InterviewError } from "./interviews";
import { decideInterview } from "./interview-decisions";

async function seedInterview() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const educ = await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  const director = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: educ.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["EDUC"], createdById: director.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "C", lastName: "I", email: "c@y.edu", emailLower: "c@y.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  const iv = await createInterview(application.id, "EDUC", director.id);
  return { iv, director, outsider, application };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("ACCEPT records the decision and creates an Acceptance", async () => {
  const { iv, director, application } = await seedInterview();
  const updated = await decideInterview(iv.id, "ACCEPT", director.id, "great");
  expect(updated.decision).toBe("ACCEPT");
  const acc = await prisma.acceptance.findUnique({ where: { applicationId_departmentCode: { applicationId: application.id, departmentCode: "EDUC" } } });
  expect(acc).not.toBeNull();
});

it("changing ACCEPT to REJECT removes the not-yet-emailed Acceptance", async () => {
  const { iv, director, application } = await seedInterview();
  await decideInterview(iv.id, "ACCEPT", director.id, null);
  await decideInterview(iv.id, "REJECT", director.id, "not a fit");
  const acc = await prisma.acceptance.findUnique({ where: { applicationId_departmentCode: { applicationId: application.id, departmentCode: "EDUC" } } });
  expect(acc).toBeNull();
});

it("does not remove an already-emailed Acceptance when changing away from ACCEPT", async () => {
  const { iv, director, application } = await seedInterview();
  await decideInterview(iv.id, "ACCEPT", director.id, null);
  await prisma.acceptance.update({ where: { applicationId_departmentCode: { applicationId: application.id, departmentCode: "EDUC" } }, data: { emailedAt: new Date() } });
  await decideInterview(iv.id, "WAITLIST", director.id, null);
  const acc = await prisma.acceptance.findUnique({ where: { applicationId_departmentCode: { applicationId: application.id, departmentCode: "EDUC" } } });
  expect(acc).not.toBeNull();
});

it("rejects a decider outside the interview's department scope", async () => {
  const { iv, outsider } = await seedInterview();
  await expect(decideInterview(iv.id, "ACCEPT", outsider.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("throws InterviewError for a missing interview", async () => {
  const { director } = await seedInterview();
  await expect(decideInterview("nope", "ACCEPT", director.id, null)).rejects.toBeInstanceOf(InterviewError);
});
