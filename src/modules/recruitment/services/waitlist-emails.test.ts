import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError, AcceptanceError } from "./review";
import { sendWaitlistEmails, waitlistEmailSummary } from "./waitlist-emails";

/**
 * A released volunteer cycle over three departments: MDIC (an ordinary
 * department), INTP (interpreting, whose waitlist recruitment excluded by name)
 * and PATS (which also assesses language before accepting, but was not
 * excluded).
 */
async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "MDIC", name: "Medical" } });
  await prisma.department.create({ data: { code: "INTP", name: "Interpreting", assessLanguageBeforeAcceptance: true } });
  await prisma.department.create({
    data: { code: "PATS", name: "Patient Services", assessLanguageBeforeAcceptance: true, assessSpanishRegardlessOfClaim: true },
  });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const other = await prisma.person.create({ data: { name: "Other", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "SRR", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: term.id,
      title: "Volunteer FA26",
      publicSlug: "v",
      departments: ["MDIC", "INTP", "PATS"],
      createdById: lead.id,
      status: "OPEN",
      decisionsReleasedAt: new Date(),
      inPersonTrainingDate: new Date("2026-09-26T12:00:00Z"),
    },
  });
  return { lead, other, cycle };
}

async function mkApp(
  cycleId: string,
  name: string,
  opts: { department?: string; decision?: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST"; languages?: string[] } = {},
) {
  const department = opts.department ?? "MDIC";
  const applicant = await prisma.applicant.create({
    data: { cycleId, firstName: name, lastName: "X", email: `${name}@y.edu`, emailLower: `${name}@y.edu` },
  });
  return prisma.application.create({
    data: {
      cycleId,
      applicantId: applicant.id,
      answers: {},
      applicantType: "NEW",
      departmentChoices: [department],
      routedDepartmentCode: department,
      languagesClaimed: opts.languages ?? [],
      decision: opts.decision ?? "WAITLIST",
    },
  });
}

const sentMail = () => prisma.emailLog.findMany({ where: { template: "recruitment.waitlist" }, orderBy: { toEmail: "asc" } });

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("emails a waitlisted applicant once: still in consideration, and no need to come to training", async () => {
  const { lead, cycle } = await seed();
  const app = await mkApp(cycle.id, "ada");

  expect(await waitlistEmailSummary(cycle.id)).toEqual({ waitlisted: 1, unnotified: 1, emailed: 0, released: true });

  expect((await sendWaitlistEmails(cycle.id, lead.id)).sent).toBe(1);
  const mail = await sentMail();
  expect(mail.map((m) => m.toEmail)).toEqual(["ada@y.edu"]);
  expect(mail[0].html).toContain("on our waitlist");
  expect(mail[0].html).toContain("do not need to attend training");
  expect(mail[0].html).toContain("Sep 26, 2026");
  expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).waitlistEmailedAt).not.toBeNull();

  // A second press tells nobody twice.
  expect((await sendWaitlistEmails(cycle.id, lead.id)).sent).toBe(0);
  expect(await sentMail()).toHaveLength(1);
  expect(await waitlistEmailSummary(cycle.id)).toEqual({ waitlisted: 1, unnotified: 0, emailed: 1, released: true });
});

/** The interpreting waitlist is the language-hold cohort, told to come to
 *  training. Excluded even once assessed: recruitment ruled out INTP by name. */
it("never emails anyone INTP waitlisted, with or without a language verdict", async () => {
  const { lead, cycle } = await seed();
  await mkApp(cycle.id, "held", { department: "INTP", languages: ["ar"] });
  const assessed = await mkApp(cycle.id, "assessed", { department: "INTP", languages: ["es"] });
  await prisma.applicationLanguageAssessment.create({
    data: { applicationId: assessed.id, language: "es", verified: true, verifiedById: lead.id },
  });

  expect((await waitlistEmailSummary(cycle.id)).waitlisted).toBe(0);
  expect((await sendWaitlistEmails(cycle.id, lead.id)).sent).toBe(0);
  expect(await sentMail()).toHaveLength(0);
});

/** PATS was not excluded, but its applicants still owed an evaluation get the
 *  hold email telling them to come to training, so this one must wait until the
 *  verdict is in. */
it("waits for a language verdict before emailing someone another department is assessing", async () => {
  const { lead, cycle } = await seed();
  const app = await mkApp(cycle.id, "pat", { department: "PATS", languages: ["es"] });

  expect((await sendWaitlistEmails(cycle.id, lead.id)).sent).toBe(0);

  await prisma.applicationLanguageAssessment.create({
    data: { applicationId: app.id, language: "es", verified: true, score: 4, verifiedById: lead.id },
  });
  expect((await sendWaitlistEmails(cycle.id, lead.id)).sent).toBe(1);
  expect((await sentMail()).map((m) => m.toEmail)).toEqual(["pat@y.edu"]);
});

it("ignores applicants who are not waitlisted, or who hold an acceptance", async () => {
  const { lead, cycle } = await seed();
  await mkApp(cycle.id, "rejected", { decision: "REJECT" });
  await mkApp(cycle.id, "pending", { decision: "PENDING" });
  const accepted = await mkApp(cycle.id, "accepted");
  await prisma.acceptance.create({ data: { applicationId: accepted.id, departmentCode: "PATS", approvedById: lead.id } });

  expect((await sendWaitlistEmails(cycle.id, lead.id)).sent).toBe(0);
  expect(await sentMail()).toHaveLength(0);
});

it("refuses before Release, without review_all, and for an archived cycle", async () => {
  const { lead, other, cycle } = await seed();
  await mkApp(cycle.id, "ada");

  await expect(sendWaitlistEmails(cycle.id, other.id)).rejects.toBeInstanceOf(RecruitmentAuthError);

  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { decisionsReleasedAt: null } });
  expect((await waitlistEmailSummary(cycle.id)).released).toBe(false);
  await expect(sendWaitlistEmails(cycle.id, lead.id)).rejects.toBeInstanceOf(AcceptanceError);

  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { decisionsReleasedAt: new Date(), status: "ARCHIVED" } });
  await expect(sendWaitlistEmails(cycle.id, lead.id)).rejects.toBeInstanceOf(AcceptanceError);
  expect(await sentMail()).toHaveLength(0);
});
