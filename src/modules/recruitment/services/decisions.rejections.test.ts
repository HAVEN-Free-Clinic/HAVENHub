import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError, AcceptanceError } from "./review";
import { sendRejections, rejectionSummary } from "./decisions";

/** A cycle whose decisions are already released, since that is the gate on
 *  sending rejections at all -- every case below except the ordering test
 *  starts from the state SRR is actually in when they press the button. */
async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "SRHD", name: "Student Run Health Dept" } });
  await prisma.department.create({ data: { code: "MDIC", name: "Medical Dept" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Recruitment Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const plain = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: term.id,
      title: "Volunteer FA26",
      publicSlug: "rv",
      departments: ["SRHD", "MDIC"],
      createdById: srr.id,
      status: "OPEN",
      decisionsReleasedAt: new Date(),
    },
  });
  return { srr, plain, cycle };
}

/** An application in the seeded cycle. `decision` is the volunteer-track signal;
 *  director-track cases add an Interview instead and leave this PENDING. */
async function mkApp(
  cycleId: string,
  email: string,
  data: { decision?: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST"; status?: "DRAFT" | "SUBMITTED" | "WITHDRAWN" } = {},
) {
  const applicant = await prisma.applicant.create({
    data: { cycleId, firstName: "A", lastName: "B", email, emailLower: email.toLowerCase() },
  });
  return prisma.application.create({
    data: {
      cycleId,
      applicantId: applicant.id,
      answers: {},
      applicantType: "NEW",
      departmentChoices: ["SRHD"],
      decision: data.decision ?? "PENDING",
      status: data.status ?? "SUBMITTED",
    },
  });
}

function rejectionMails() {
  return prisma.emailLog.findMany({ where: { template: "recruitment.rejection" }, orderBy: { toEmail: "asc" } });
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("emails every rejected applicant once, stamps rejectionEmailedAt, and is idempotent", async () => {
  const { srr, cycle } = await seed();
  const rejected = await mkApp(cycle.id, "rejected@yale.edu", { decision: "REJECT" });
  await mkApp(cycle.id, "pending@yale.edu");

  const res = await sendRejections(cycle.id, srr.id);
  expect(res.sent).toBe(1);

  const mails = await rejectionMails();
  expect(mails).toHaveLength(1);
  expect(mails[0].toEmail).toBe("rejected@yale.edu");

  const after = await prisma.application.findUniqueOrThrow({ where: { id: rejected.id } });
  expect(after.rejectionEmailedAt).not.toBeNull();

  // A second press sends nothing: the claim only ever fires from null.
  const again = await sendRejections(cycle.id, srr.id);
  expect(again.sent).toBe(0);
  expect(await rejectionMails()).toHaveLength(1);
});

it("never emails an applicant who holds an acceptance, even with a REJECT from another department", async () => {
  const { srr, cycle } = await seed();
  const app = await mkApp(cycle.id, "accepted@yale.edu", { decision: "REJECT" });
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "MDIC", approvedById: srr.id } });

  expect((await sendRejections(cycle.id, srr.id)).sent).toBe(0);
  expect(await rejectionMails()).toHaveLength(0);
});

it("never emails a waitlisted applicant", async () => {
  const { srr, cycle } = await seed();
  await mkApp(cycle.id, "waitlisted@yale.edu", { decision: "WAITLIST" });

  expect((await sendRejections(cycle.id, srr.id)).sent).toBe(0);
  expect(await rejectionMails()).toHaveLength(0);
});

it("never emails an undecided applicant, so an unreviewed application is not told it lost", async () => {
  const { srr, cycle } = await seed();
  await mkApp(cycle.id, "unreviewed@yale.edu", { decision: "PENDING" });

  expect((await sendRejections(cycle.id, srr.id)).sent).toBe(0);
  expect(await rejectionMails()).toHaveLength(0);
});

it("never emails an applicant who withdrew, or one whose application is still a draft", async () => {
  const { srr, cycle } = await seed();
  await mkApp(cycle.id, "withdrew@yale.edu", { decision: "REJECT", status: "WITHDRAWN" });
  await mkApp(cycle.id, "draft@yale.edu", { decision: "REJECT", status: "DRAFT" });

  expect((await sendRejections(cycle.id, srr.id)).sent).toBe(0);
  expect(await rejectionMails()).toHaveLength(0);
});

it("emails a director-track applicant rejected on their interview", async () => {
  const { srr, cycle } = await seed();
  const app = await mkApp(cycle.id, "director@yale.edu");
  await prisma.interview.create({ data: { applicationId: app.id, departmentCode: "SRHD", createdById: srr.id, decision: "REJECT" } });

  expect((await sendRejections(cycle.id, srr.id)).sent).toBe(1);
  const mails = await rejectionMails();
  expect(mails[0].toEmail).toBe("director@yale.edu");
});

it("does not email a director-track applicant who is rejected by one department but still pending at another", async () => {
  const { srr, cycle } = await seed();
  const app = await mkApp(cycle.id, "half@yale.edu");
  await prisma.interview.create({ data: { applicationId: app.id, departmentCode: "SRHD", createdById: srr.id, decision: "REJECT" } });
  await prisma.interview.create({ data: { applicationId: app.id, departmentCode: "MDIC", createdById: srr.id, decision: "PENDING" } });

  // rosterDecision only reads REJECTED once nothing outranks it, and a PENDING
  // interview means this applicant is still in play at MDIC.
  expect((await sendRejections(cycle.id, srr.id)).sent).toBe(0);
  expect(await rejectionMails()).toHaveLength(0);
});

it("refuses to send before decisions are released", async () => {
  const { srr, cycle } = await seed();
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { decisionsReleasedAt: null } });
  await mkApp(cycle.id, "rejected@yale.edu", { decision: "REJECT" });

  await expect(sendRejections(cycle.id, srr.id)).rejects.toBeInstanceOf(AcceptanceError);
  expect(await rejectionMails()).toHaveLength(0);
});

it("refuses to send for a DRAFT or ARCHIVED cycle", async () => {
  const { srr, cycle } = await seed();
  await mkApp(cycle.id, "rejected@yale.edu", { decision: "REJECT" });

  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "DRAFT" } });
  await expect(sendRejections(cycle.id, srr.id)).rejects.toBeInstanceOf(AcceptanceError);

  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "ARCHIVED" } });
  await expect(sendRejections(cycle.id, srr.id)).rejects.toBeInstanceOf(AcceptanceError);

  expect(await rejectionMails()).toHaveLength(0);
});

it("requires review_all", async () => {
  const { plain, cycle } = await seed();
  await expect(sendRejections(cycle.id, plain.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("two concurrent sends email the applicant only once", async () => {
  const { srr, cycle } = await seed();
  await mkApp(cycle.id, "rejected@yale.edu", { decision: "REJECT" });

  const [a, b] = await Promise.all([sendRejections(cycle.id, srr.id), sendRejections(cycle.id, srr.id)]);
  expect(a.sent + b.sent).toBe(1);
  expect(await rejectionMails()).toHaveLength(1);
});

it("uses the cycle's rejection email override when present, wrapped in the layout", async () => {
  const { srr, cycle } = await seed();
  await mkApp(cycle.id, "rejected@yale.edu", { decision: "REJECT" });
  await prisma.recruitmentCycleEmail.create({
    data: { cycleId: cycle.id, key: "recruitment.rejection", subject: "About {{ cycleTitle }}", body: "<p>Sorry {{ firstName }}</p>" },
  });

  await sendRejections(cycle.id, srr.id);
  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.rejection" } });
  expect(mail.subject).toBe("About Volunteer FA26");
  expect(mail.html).toContain("Sorry A");
  expect(mail.html).toContain("<!DOCTYPE html>");
});

it("rejectionSummary counts the cohort, the outstanding sends, and whether release has happened", async () => {
  const { srr, cycle } = await seed();
  await mkApp(cycle.id, "r1@yale.edu", { decision: "REJECT" });
  await mkApp(cycle.id, "r2@yale.edu", { decision: "REJECT" });
  await mkApp(cycle.id, "waitlisted@yale.edu", { decision: "WAITLIST" });

  expect(await rejectionSummary(cycle.id)).toEqual({ rejected: 2, unnotified: 2, emailed: 0, released: true });

  await sendRejections(cycle.id, srr.id);
  expect(await rejectionSummary(cycle.id)).toEqual({ rejected: 2, unnotified: 0, emailed: 2, released: true });
});

it("reports released: false before release, which is what disables the button", async () => {
  const { cycle } = await seed();
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { decisionsReleasedAt: null } });
  expect((await rejectionSummary(cycle.id)).released).toBe(false);
});
