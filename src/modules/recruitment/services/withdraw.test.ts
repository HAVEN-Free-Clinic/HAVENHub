import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { withdrawApplication, WithdrawError } from "./withdraw";
import { releaseDecisions } from "./decisions";
import { createOrResendContract } from "./onboarding";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

/** A published volunteer cycle with one applicant holding one application.
 *  Later tasks append their tests to THIS file and reuse this fixture rather
 *  than writing their own, so it stays module-private (no export). */
async function seedCycle(
  slug: string,
  email: string,
  opts: { appStatus?: "DRAFT" | "SUBMITTED" | "WITHDRAWN"; cycleStatus?: "OPEN" | "CLOSED" } = {},
) {
  const appStatus = opts.appStatus ?? "SUBMITTED";
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "RA " + slug, grants: { create: [{ permission: "recruitment.review_all" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(), status: "ACTIVE" },
  });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "Student Run Health Dept" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: "Volunteer 2026", publicSlug: slug,
      departments: ["SRHD"], createdById: srr.id, status: opts.cycleStatus ?? "OPEN",
    },
  });
  const applicant = await prisma.applicant.create({
    data: { cycleId: cycle.id, firstName: "Reed", lastName: "Rivers", email, emailLower: email.toLowerCase() },
  });
  const app = await prisma.application.create({
    data: {
      cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW",
      departmentChoices: ["SRHD"], status: appStatus,
      submittedAt: appStatus === "DRAFT" ? null : new Date(),
    },
  });
  return { srr, term, dept, cycle, applicant, app };
}

/** The portal identity shape (email is always already lowercased). */
const ID = (email: string) => ({ email: email.toLowerCase(), personId: null, firstName: null });

it("stores a WITHDRAWN application with a withdrawnAt stamp", async () => {
  const { app } = await seedCycle("w-schema", "reed@yale.edu", { appStatus: "WITHDRAWN" });
  const stamped = await prisma.application.update({
    where: { id: app.id },
    data: { withdrawnAt: new Date() },
  });
  expect(stamped.status).toBe("WITHDRAWN");
  expect(stamped.withdrawnAt).toBeInstanceOf(Date);
});

it("withdraws a submitted application and stamps withdrawnAt", async () => {
  const { app } = await seedCycle("w1", "reed@yale.edu");
  const res = await withdrawApplication("w1", ID("reed@yale.edu"));
  expect(res.kind).toBe("withdraw");
  const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  expect(after.status).toBe("WITHDRAWN");
  expect(after.withdrawnAt).toBeInstanceOf(Date);
});

it("reports decline_offer when an acceptance exists", async () => {
  const { srr, app } = await seedCycle("w2", "reed@yale.edu");
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id } });
  const res = await withdrawApplication("w2", ID("reed@yale.edu"));
  expect(res.kind).toBe("decline_offer");
});

it("leaves acceptances, contracts, and interviews untouched", async () => {
  const { srr, app, cycle } = await seedCycle("w3", "reed@yale.edu");
  const acc = await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id } });
  await releaseDecisions(cycle.id, srr.id);
  await createOrResendContract(acc.id, srr.id, "http://test");
  const iv = await prisma.interview.create({
    data: { applicationId: app.id, departmentCode: "SRHD", createdById: srr.id, scheduledAt: new Date() },
  });

  await withdrawApplication("w3", ID("reed@yale.edu"));

  expect(await prisma.acceptance.count({ where: { id: acc.id } })).toBe(1);
  expect(await prisma.onboardingContract.count({ where: { acceptanceId: acc.id } })).toBe(1);
  expect(await prisma.interview.count({ where: { id: iv.id } })).toBe(1);
});

it("refuses once the onboarding contract is promoted", async () => {
  const { srr, app, cycle } = await seedCycle("w4", "reed@yale.edu");
  const acc = await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id } });
  await releaseDecisions(cycle.id, srr.id);
  await createOrResendContract(acc.id, srr.id, "http://test");
  await prisma.onboardingContract.update({
    where: { acceptanceId: acc.id },
    data: { status: "PROMOTED", promotedAt: new Date() },
  });
  await expect(withdrawApplication("w4", ID("reed@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
  expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).status).toBe("SUBMITTED");
});

it("is idempotent: a second call rejects and does not restamp", async () => {
  const { app } = await seedCycle("w5", "reed@yale.edu");
  await withdrawApplication("w5", ID("reed@yale.edu"));
  const first = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  await expect(withdrawApplication("w5", ID("reed@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
  const second = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  expect(second.withdrawnAt?.getTime()).toBe(first.withdrawnAt?.getTime());
});

it("refuses to touch another applicant's application", async () => {
  const { app } = await seedCycle("w6", "reed@yale.edu");
  await expect(withdrawApplication("w6", ID("intruder@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
  expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).status).toBe("SUBMITTED");
});

it("refuses on an unsubmitted draft", async () => {
  await seedCycle("w7", "reed@yale.edu", { appStatus: "DRAFT" });
  await expect(withdrawApplication("w7", ID("reed@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
});
