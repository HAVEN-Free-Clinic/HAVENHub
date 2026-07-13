import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError, AcceptanceError } from "./review";
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

it("refuses to flip a decision away from ACCEPT once an onboarding contract exists (audit M1)", async () => {
  const { iv, director, application } = await seedInterview();
  await decideInterview(iv.id, "ACCEPT", director.id, null);
  const acc = await prisma.acceptance.findUniqueOrThrow({ where: { applicationId_departmentCode: { applicationId: application.id, departmentCode: "EDUC" } } });
  // Onboarding was started/promoted without the acceptance ever being emailed.
  await prisma.onboardingContract.create({ data: { acceptanceId: acc.id, token: "tok-m1", status: "PROMOTED", firstName: "C", lastName: "I", email: "c@y.edu" } });
  await expect(decideInterview(iv.id, "REJECT", director.id, null)).rejects.toBeInstanceOf(AcceptanceError);
  // The contract and its acceptance are preserved and the decision stays ACCEPT.
  expect(await prisma.onboardingContract.findFirst({ where: { acceptanceId: acc.id } })).not.toBeNull();
  expect(await prisma.acceptance.findUnique({ where: { id: acc.id } })).not.toBeNull();
  expect((await prisma.interview.findUniqueOrThrow({ where: { id: iv.id } })).decision).toBe("ACCEPT");
});

it("changing ACCEPT to REJECT removes the not-yet-emailed Acceptance", async () => {
  const { iv, director, application } = await seedInterview();
  await decideInterview(iv.id, "ACCEPT", director.id, null);
  await decideInterview(iv.id, "REJECT", director.id, "not a fit");
  const acc = await prisma.acceptance.findUnique({ where: { applicationId_departmentCode: { applicationId: application.id, departmentCode: "EDUC" } } });
  expect(acc).toBeNull();
});

it("blocks changing away from ACCEPT once the Acceptance has been emailed, leaving the decision unchanged", async () => {
  const { iv, director, application } = await seedInterview();
  await decideInterview(iv.id, "ACCEPT", director.id, null);
  await prisma.acceptance.update({ where: { applicationId_departmentCode: { applicationId: application.id, departmentCode: "EDUC" } }, data: { emailedAt: new Date() } });

  await expect(decideInterview(iv.id, "WAITLIST", director.id, null)).rejects.toBeInstanceOf(AcceptanceError);

  // The emailed acceptance is preserved AND the decision is not flipped, so the
  // internal decision can't silently diverge from the applicant-facing acceptance
  // (issue #77: a notified acceptance must be rescinded before the decision changes).
  const acc = await prisma.acceptance.findUnique({ where: { applicationId_departmentCode: { applicationId: application.id, departmentCode: "EDUC" } } });
  expect(acc).not.toBeNull();
  const refreshed = await prisma.interview.findUnique({ where: { id: iv.id } });
  expect(refreshed?.decision).toBe("ACCEPT");
});

it("rejects a decider outside the interview's department scope", async () => {
  const { iv, outsider } = await seedInterview();
  await expect(decideInterview(iv.id, "ACCEPT", outsider.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("blocks a director from deciding their own interview (self-approval, separation of duties)", async () => {
  const { iv, director, application } = await seedInterview();
  // The applicant is the director themselves (a signed-in incumbent re-applying).
  await prisma.applicant.update({ where: { id: application.applicantId }, data: { applicantPersonId: director.id } });
  await expect(decideInterview(iv.id, "ACCEPT", director.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  expect(await prisma.acceptance.count({ where: { applicationId: application.id } })).toBe(0);
  expect((await prisma.interview.findUniqueOrThrow({ where: { id: iv.id } })).decidedById).toBeNull();
});

it("still lets a director decide an interview for a different signed-in applicant", async () => {
  const { iv, director, outsider, application } = await seedInterview();
  await prisma.applicant.update({ where: { id: application.applicantId }, data: { applicantPersonId: outsider.id } });
  const updated = await decideInterview(iv.id, "ACCEPT", director.id, null);
  expect(updated.decision).toBe("ACCEPT");
});

it("throws InterviewError for a missing interview", async () => {
  const { director } = await seedInterview();
  await expect(decideInterview("nope", "ACCEPT", director.id, null)).rejects.toBeInstanceOf(InterviewError);
});

it("refuses to accept an interview whose application is a DRAFT and mints no Acceptance (audit3 L1)", async () => {
  const { iv, director, application } = await seedInterview();
  // The application reverted to DRAFT after the interview was created; an ACCEPT
  // must not turn a draft into an Acceptance (mirrors acceptApplicant).
  await prisma.application.update({ where: { id: application.id }, data: { status: "DRAFT" } });
  await expect(decideInterview(iv.id, "ACCEPT", director.id, null)).rejects.toBeInstanceOf(InterviewError);
  expect(await prisma.acceptance.count({ where: { applicationId: application.id } })).toBe(0);
});
