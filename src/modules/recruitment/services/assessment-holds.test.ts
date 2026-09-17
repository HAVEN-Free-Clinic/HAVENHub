import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError, AcceptanceError } from "./review";
import { assessmentHoldSummary, sendAssessmentHolds } from "./assessment-holds";

/**
 * A cycle whose department assesses language before accepting (the INTP/PATS
 * lane), with one waitlisted applicant who claimed Arabic and has no verdict on
 * file -- the exact shape this send exists for.
 */
async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "INTP", name: "Interpreting", assessLanguageBeforeAcceptance: true } });
  await prisma.department.create({ data: { code: "MDIC", name: "Medical" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const other = await prisma.person.create({ data: { name: "Other", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "SRR", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({
    data: { track: "VOLUNTEER", termId: term.id, title: "Volunteer FA26", publicSlug: "v", departments: ["INTP", "MDIC"], createdById: lead.id, status: "OPEN" },
  });
  return { term, lead, other, cycle };
}

async function waitlistedApplicant(cycleId: string, name: string, opts?: { languages?: string[]; department?: string }) {
  const applicant = await prisma.applicant.create({
    data: { cycleId, firstName: name, lastName: "X", email: `${name}@y.edu`, emailLower: `${name}@y.edu` },
  });
  return prisma.application.create({
    data: {
      cycleId,
      applicantId: applicant.id,
      answers: {},
      applicantType: "NEW",
      departmentChoices: [opts?.department ?? "INTP"],
      routedDepartmentCode: opts?.department ?? "INTP",
      languagesClaimed: opts?.languages ?? ["ar"],
      decision: "WAITLIST",
    },
  });
}

const sentMail = () => prisma.emailLog.findMany({ where: { template: "recruitment.assessment_hold" }, orderBy: { toEmail: "asc" } });

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("counts and emails a waitlisted applicant still awaiting an evaluation", async () => {
  const { lead, cycle } = await seed();
  await waitlistedApplicant(cycle.id, "ada");

  expect(await assessmentHoldSummary(cycle.id)).toEqual({ onHold: 1, unnotified: 1, emailed: 0 });

  const res = await sendAssessmentHolds(cycle.id, lead.id);
  expect(res.sent).toBe(1);

  const mail = await sentMail();
  expect(mail).toHaveLength(1);
  expect(mail[0].toEmail).toBe("ada@y.edu");
  // The three jobs the email exists to do.
  expect(mail[0].html).toContain("not a rejection");
  expect(mail[0].html).toContain("dialect");
  expect(mail[0].html).toContain("training roster");
  // Their own claimed language, written out rather than as a code.
  expect(mail[0].html).toContain("Arabic");

  expect(await assessmentHoldSummary(cycle.id)).toEqual({ onHold: 1, unnotified: 0, emailed: 1 });
});

it("is idempotent: a second run tells nobody twice", async () => {
  const { lead, cycle } = await seed();
  await waitlistedApplicant(cycle.id, "ada");
  await sendAssessmentHolds(cycle.id, lead.id);

  expect((await sendAssessmentHolds(cycle.id, lead.id)).sent).toBe(0);
  expect(await sentMail()).toHaveLength(1);
});

/**
 * The verdict is what takes someone off this list. Recording one leaves them
 * waitlisted but no longer waiting on the clinic, so they are a decision to
 * make rather than an apology to send.
 */
it("drops an applicant once their language has a verdict", async () => {
  const { lead, cycle } = await seed();
  const app = await waitlistedApplicant(cycle.id, "ada");
  await prisma.applicationLanguageAssessment.create({
    data: { applicationId: app.id, language: "ar", verified: true, verifiedById: lead.id },
  });

  expect((await assessmentHoldSummary(cycle.id)).onHold).toBe(0);
  expect((await sendAssessmentHolds(cycle.id, lead.id)).sent).toBe(0);
});

/** Nobody outside the lane is on hold, however they were waitlisted. */
it("ignores a waitlisted applicant whose department does not assess language", async () => {
  const { lead, cycle } = await seed();
  await waitlistedApplicant(cycle.id, "bo", { department: "MDIC", languages: [] });

  expect((await assessmentHoldSummary(cycle.id)).onHold).toBe(0);
  expect((await sendAssessmentHolds(cycle.id, lead.id)).sent).toBe(0);
});

it("ignores an applicant who is not waitlisted", async () => {
  const { lead, cycle } = await seed();
  const app = await waitlistedApplicant(cycle.id, "cy");
  await prisma.application.update({ where: { id: app.id }, data: { decision: "PENDING" } });

  expect((await assessmentHoldSummary(cycle.id)).onHold).toBe(0);
  expect((await sendAssessmentHolds(cycle.id, lead.id)).sent).toBe(0);
});

it("refuses a viewer without review_all, and an archived cycle", async () => {
  const { lead, other, cycle } = await seed();
  await waitlistedApplicant(cycle.id, "ada");

  await expect(sendAssessmentHolds(cycle.id, other.id)).rejects.toBeInstanceOf(RecruitmentAuthError);

  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "ARCHIVED" } });
  await expect(sendAssessmentHolds(cycle.id, lead.id)).rejects.toBeInstanceOf(AcceptanceError);
  expect(await sentMail()).toHaveLength(0);
});
