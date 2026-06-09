import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { acceptApplicant, RecruitmentAuthError } from "./review";
import { listConflicts, releaseSummary, releaseDecisions } from "./decisions";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const srhd = await prisma.department.create({ data: { code: "SRHD", name: "Student Run Health Dept" } });
  const mdic = await prisma.department.create({ data: { code: "MDIC", name: "Medical Dept" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Recruitment Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const plain = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "rv", departments: ["SRHD", "MDIC"], createdById: srr.id, status: "OPEN" } });
  const mkApp = async (email: string, choices: string[]) => {
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email, emailLower: email.toLowerCase() } });
    return prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: choices } });
  };
  const clean = await mkApp("clean@yale.edu", ["SRHD"]);
  const conflicted = await mkApp("conf@yale.edu", ["SRHD", "MDIC"]);
  return { srr, plain, cycle, srhd, mdic, clean, conflicted };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("lists conflicts (applications accepted by >1 department)", async () => {
  const { srr, cycle, clean, conflicted } = await seed();
  await acceptApplicant(clean.id, "SRHD", srr.id, null);
  await acceptApplicant(conflicted.id, "SRHD", srr.id, null);
  await acceptApplicant(conflicted.id, "MDIC", srr.id, null);
  const conflicts = await listConflicts(cycle.id);
  expect(conflicts.map((c) => c.applicationId)).toEqual([conflicted.id]);
  expect(conflicts[0].departments.sort()).toEqual(["MDIC", "SRHD"]);
});

it("release sends one email per accepted, non-conflicted, un-emailed acceptance and stamps emailedAt; idempotent", async () => {
  const { srr, cycle, clean, conflicted } = await seed();
  await acceptApplicant(clean.id, "SRHD", srr.id, null);
  await acceptApplicant(conflicted.id, "SRHD", srr.id, null);
  await acceptApplicant(conflicted.id, "MDIC", srr.id, null);

  const res = await releaseDecisions(cycle.id, srr.id);
  expect(res.sent).toBe(1);
  expect(res.skippedConflicted).toBe(1);

  const emails = await prisma.emailLog.findMany();
  expect(emails).toHaveLength(1);
  expect(emails[0].toEmail).toBe("clean@yale.edu");
  expect(emails[0].template).toBe("recruitment.acceptance");

  const cleanAcc = await prisma.acceptance.findFirstOrThrow({ where: { applicationId: clean.id } });
  expect(cleanAcc.emailedAt).not.toBeNull();

  const again = await releaseDecisions(cycle.id, srr.id);
  expect(again.sent).toBe(0);
  expect(await prisma.emailLog.count()).toBe(1);
});

it("requires review_all", async () => {
  const { plain, cycle } = await seed();
  await expect(releaseDecisions(cycle.id, plain.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("releaseSummary reports the counts", async () => {
  const { srr, cycle, clean, conflicted } = await seed();
  await acceptApplicant(clean.id, "SRHD", srr.id, null);
  await acceptApplicant(conflicted.id, "SRHD", srr.id, null);
  await acceptApplicant(conflicted.id, "MDIC", srr.id, null);
  const s = await releaseSummary(cycle.id);
  expect(s.acceptedApplications).toBe(2);
  expect(s.conflictedApplications).toBe(1);
  expect(s.unnotified).toBe(1);
  expect(s.emailed).toBe(0);
});
