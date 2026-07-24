import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { listConflicts, releaseSummary, releaseDecisions, sendAcceptanceEmail } from "./decisions";

function accept(applicationId: string, departmentCode: string, approvedById: string) {
  return prisma.acceptance.create({ data: { applicationId, departmentCode, approvedById } });
}

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
  await accept(clean.id, "SRHD", srr.id);
  await accept(conflicted.id, "SRHD", srr.id);
  await accept(conflicted.id, "MDIC", srr.id);
  const conflicts = await listConflicts(cycle.id);
  expect(conflicts.map((c) => c.applicationId)).toEqual([conflicted.id]);
  expect(conflicts[0].departments.sort()).toEqual(["MDIC", "SRHD"]);
});

it("release sends one email per accepted, non-conflicted, un-emailed acceptance and stamps emailedAt; idempotent", async () => {
  const { srr, cycle, clean, conflicted } = await seed();
  await accept(clean.id, "SRHD", srr.id);
  await accept(conflicted.id, "SRHD", srr.id);
  await accept(conflicted.id, "MDIC", srr.id);

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

it("two concurrent releases send the acceptance email only once (audit3 L15)", async () => {
  const { srr, cycle, clean } = await seed();
  await accept(clean.id, "SRHD", srr.id);
  // Fire two releases at once. The atomic emailedAt: null claim means only one
  // stamps and queues the email; the loser neither re-sends nor re-stamps.
  const [a, b] = await Promise.all([releaseDecisions(cycle.id, srr.id), releaseDecisions(cycle.id, srr.id)]);
  expect(a.sent + b.sent).toBe(1);
  expect(await prisma.emailLog.count({ where: { template: "recruitment.acceptance" } })).toBe(1);
  const acc = await prisma.acceptance.findFirstOrThrow({ where: { applicationId: clean.id } });
  expect(acc.emailedAt).not.toBeNull();
});

it("stamps decisionsReleasedAt on the cycle when decisions are released", async () => {
  const { srr, cycle, clean } = await seed();
  await accept(clean.id, "SRHD", srr.id);
  expect((await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycle.id } })).decisionsReleasedAt).toBeNull();
  await releaseDecisions(cycle.id, srr.id);
  expect((await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycle.id } })).decisionsReleasedAt).not.toBeNull();
});

it("stamps decisionsReleasedAt even when there are no acceptances (all not-selected)", async () => {
  const { srr, cycle } = await seed();
  const res = await releaseDecisions(cycle.id, srr.id);
  expect(res.sent).toBe(0);
  expect((await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycle.id } })).decisionsReleasedAt).not.toBeNull();
});

it("releaseSummary reports the counts", async () => {
  const { srr, cycle, clean, conflicted } = await seed();
  await accept(clean.id, "SRHD", srr.id);
  await accept(conflicted.id, "SRHD", srr.id);
  await accept(conflicted.id, "MDIC", srr.id);
  const s = await releaseSummary(cycle.id);
  expect(s.acceptedApplications).toBe(2);
  expect(s.conflictedApplications).toBe(1);
  expect(s.unnotified).toBe(1);
  expect(s.emailed).toBe(0);
});

it("sendAcceptanceEmail sends the acceptance email for one acceptance and stamps emailedAt", async () => {
  const { srr, clean } = await seed();
  await accept(clean.id, "SRHD", srr.id);
  const res = await sendAcceptanceEmail(clean.id, "SRHD");
  expect(res).toEqual({ sent: true });
  const emails = await prisma.emailLog.findMany();
  expect(emails).toHaveLength(1);
  expect(emails[0].toEmail).toBe("clean@yale.edu");
  expect(emails[0].template).toBe("recruitment.acceptance");
  const acc = await prisma.acceptance.findFirstOrThrow({ where: { applicationId: clean.id } });
  expect(acc.emailedAt).not.toBeNull();
});

it("sendAcceptanceEmail is idempotent: an already-emailed acceptance is not re-sent (nor double-sent with a later release)", async () => {
  const { srr, cycle, clean } = await seed();
  await accept(clean.id, "SRHD", srr.id);
  expect(await sendAcceptanceEmail(clean.id, "SRHD")).toEqual({ sent: true });
  expect(await sendAcceptanceEmail(clean.id, "SRHD")).toEqual({ sent: false, reason: "already_emailed" });
  // A later release must not re-send the same acceptance.
  const rel = await releaseDecisions(cycle.id, srr.id);
  expect(rel.sent).toBe(0);
  expect(await prisma.emailLog.count()).toBe(1);
});

it("sendAcceptanceEmail does not email a conflicted applicant (accepted by >1 department)", async () => {
  const { srr, conflicted } = await seed();
  await accept(conflicted.id, "SRHD", srr.id);
  await accept(conflicted.id, "MDIC", srr.id);
  const res = await sendAcceptanceEmail(conflicted.id, "SRHD");
  expect(res).toEqual({ sent: false, reason: "conflicted" });
  expect(await prisma.emailLog.count()).toBe(0);
  const accs = await prisma.acceptance.findMany({ where: { applicationId: conflicted.id } });
  expect(accs.every((a) => a.emailedAt === null)).toBe(true);
});

it("sendAcceptanceEmail returns not_found when there is no such acceptance", async () => {
  const { clean } = await seed();
  expect(await sendAcceptanceEmail(clean.id, "SRHD")).toEqual({ sent: false, reason: "not_found" });
});

it("resolves the department NAME in the acceptance email even when the code was removed from the cycle (#100)", async () => {
  const { srr, cycle, clean } = await seed();
  await accept(clean.id, "SRHD", srr.id); // accepted to SRHD ("Student Run Health Dept")
  // SRR removes SRHD from the cycle after routing already produced SRHD acceptances
  // (setCycleDepartments allows this and only warns). The acceptance's departmentCode
  // now falls outside cycle.departments.
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { departments: ["MDIC"] } });
  await prisma.recruitmentCycleEmail.create({
    data: { cycleId: cycle.id, key: "recruitment.acceptance", subject: "Accept", body: "<p>Joined {{ departmentName }}</p>" },
  });

  await releaseDecisions(cycle.id, srr.id);

  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.acceptance" } });
  expect(mail.html).toContain("Student Run Health Dept"); // the name, not the bare "SRHD" code
});

it("uses the cycle's acceptance email override when present", async () => {
  const { srr, cycle, clean } = await seed();
  await accept(clean.id, "SRHD", srr.id);
  const cycleId = cycle.id;
  const actorId = srr.id;
  await prisma.recruitmentCycleEmail.create({
    data: { cycleId, key: "recruitment.acceptance", subject: "Custom accept {{ firstName }}", body: "<p>Joined {{ departmentName }}</p>" },
  });
  await releaseDecisions(cycleId, actorId);
  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.acceptance" } });
  expect(mail.subject).toBe("Custom accept A");
  expect(mail.html).toContain("Joined");
  expect(mail.html).toContain("<!DOCTYPE html>");
});
