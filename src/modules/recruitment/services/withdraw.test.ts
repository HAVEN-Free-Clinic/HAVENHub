import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { withdrawApplication, discardDraft, reopenWithdrawnApplication, WithdrawError } from "./withdraw";
import { releaseDecisions } from "./decisions";
import { createOrResendContract } from "./onboarding";
import { listApplicantsForReview } from "./review";
import { pendingReviewCount } from "./review-digest";
import { myAssignedInterviews } from "./interviews";
import { promoteContracts } from "./promotion";

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

/** A SECOND applicant, with their own application, inside an EXISTING cycle.
 *  Cross-applicant isolation cannot be proved with one seeded applicant: an
 *  identity matching nobody only ever exercises the not-found path. */
async function addApplicant(
  cycleId: string,
  email: string,
  opts: { personId?: string; appStatus?: "DRAFT" | "SUBMITTED" } = {},
) {
  const appStatus = opts.appStatus ?? "SUBMITTED";
  const applicant = await prisma.applicant.create({
    data: {
      cycleId, firstName: "Blake", lastName: "Brooks", email, emailLower: email.toLowerCase(),
      applicantPersonId: opts.personId ?? null,
    },
  });
  const app = await prisma.application.create({
    data: {
      cycleId, applicantId: applicant.id, answers: {}, applicantType: "NEW",
      departmentChoices: ["SRHD"], status: appStatus,
      submittedAt: appStatus === "DRAFT" ? null : new Date(),
    },
  });
  return { applicant, app };
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

it("reports withdraw, not decline_offer, while a recorded acceptance is still unreleased", async () => {
  const { srr, app } = await seedCycle("w2", "reed@yale.edu");
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id } });
  // Decision recorded, Release not yet run. The applicant has been told nothing,
  // which is exactly why portal-status still offers them "Withdraw application".
  // The service must agree with the control the portal rendered.
  const res = await withdrawApplication("w2", ID("reed@yale.edu"));
  expect(res.kind).toBe("withdraw");
});

it("reports decline_offer once the acceptance email has gone out", async () => {
  const { srr, app, cycle } = await seedCycle("w2b", "reed@yale.edu");
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id } });
  await releaseDecisions(cycle.id, srr.id);
  const res = await withdrawApplication("w2b", ID("reed@yale.edu"));
  expect(res.kind).toBe("decline_offer");
});

it("reports decline_offer once onboarding paperwork reached them, even before release", async () => {
  const { srr, app } = await seedCycle("w2c", "reed@yale.edu");
  const acc = await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id } });
  // The onboarding link is itself an acceptance notification, so a contract with
  // no emailedAt still means the applicant knows they were offered a place.
  await createOrResendContract(acc.id, srr.id, "http://test");
  const res = await withdrawApplication("w2c", ID("reed@yale.edu"));
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

it("refuses when no applicant in the cycle matches the identity at all", async () => {
  const { app } = await seedCycle("w6", "reed@yale.edu");
  await expect(withdrawApplication("w6", ID("intruder@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
  expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).status).toBe("SUBMITTED");
});

it("withdraws only the caller's own row, never a co-applicant's in the same cycle", async () => {
  const { cycle, app: victim } = await seedCycle("w6b", "reed@yale.edu");
  const { app: mine } = await addApplicant(cycle.id, "blake@yale.edu");

  await withdrawApplication("w6b", ID("blake@yale.edu"));

  expect((await prisma.application.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe("WITHDRAWN");
  const untouched = await prisma.application.findUniqueOrThrow({ where: { id: victim.id } });
  expect(untouched.status).toBe("SUBMITTED");
  expect(untouched.withdrawnAt).toBeNull();
});

it("resolves through applicantPersonId without reaching another applicant's row", async () => {
  const { cycle, app: victim } = await seedCycle("w6c", "reed@yale.edu");
  const blake = await prisma.person.create({ data: { name: "Blake Brooks", status: "ACTIVE" } });
  const { app: mine } = await addApplicant(cycle.id, "blake@yale.edu", { personId: blake.id });

  // Signed in as Blake under a DIFFERENT address, so only the applicantPersonId
  // arm of findOwnApplication's OR can match. Every other test here pins
  // personId to null, which leaves that arm entirely unexercised.
  await withdrawApplication("w6c", { email: "blake.brooks@gmail.com", personId: blake.id, firstName: null });

  expect((await prisma.application.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe("WITHDRAWN");
  const untouched = await prisma.application.findUniqueOrThrow({ where: { id: victim.id } });
  expect(untouched.status).toBe("SUBMITTED");
  expect(untouched.withdrawnAt).toBeNull();
});

it("refuses a signed-in person who holds no application in the cycle", async () => {
  const { cycle, app: victim } = await seedCycle("w6d", "reed@yale.edu");
  const { app: other } = await addApplicant(cycle.id, "blake@yale.edu");
  const stranger = await prisma.person.create({ data: { name: "Casey Stranger", status: "ACTIVE" } });

  await expect(
    withdrawApplication("w6d", { email: "casey@yale.edu", personId: stranger.id, firstName: null }),
  ).rejects.toBeInstanceOf(WithdrawError);

  expect((await prisma.application.findUniqueOrThrow({ where: { id: victim.id } })).status).toBe("SUBMITTED");
  expect((await prisma.application.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("SUBMITTED");
});

it("refuses on an unsubmitted draft", async () => {
  await seedCycle("w7", "reed@yale.edu", { appStatus: "DRAFT" });
  await expect(withdrawApplication("w7", ID("reed@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
});

/** Grant a permission to a fresh person and return them. */
async function personWithPermission(name: string, permission: string) {
  const p = await prisma.person.create({ data: { name, status: "ACTIVE", contactEmail: `${name}@yale.edu` } });
  const role = await prisma.role.create({ data: { name: `${name}-role`, grants: { create: [{ permission }] } } });
  await prisma.roleAssignment.create({ data: { personId: p.id, roleId: role.id } });
  return p;
}

it("notifies the panel when a scheduled interview is withdrawn from", async () => {
  const { srr, app } = await seedCycle("w8", "reed@yale.edu");
  const panelist = await prisma.person.create({
    data: { name: "Pat Panel", status: "ACTIVE", contactEmail: "pat@yale.edu" },
  });
  const iv = await prisma.interview.create({
    data: { applicationId: app.id, departmentCode: "SRHD", createdById: srr.id, scheduledAt: new Date() },
  });
  await prisma.interviewPanelist.create({ data: { interviewId: iv.id, personId: panelist.id } });

  await withdrawApplication("w8", ID("reed@yale.edu"));

  const queued = await prisma.notification.findMany({ where: { personId: panelist.id } });
  expect(queued).toHaveLength(1);
});

it("stays silent for a plain under-review withdrawal", async () => {
  await seedCycle("w9", "reed@yale.edu");
  await withdrawApplication("w9", ID("reed@yale.edu"));
  // notify() always writes an inbox row, so a zero count proves nobody was told
  // through any channel.
  expect(await prisma.notification.count()).toBe(0);
});

it("notifies review_all holders when a released offer is declined", async () => {
  const { srr, app, cycle } = await seedCycle("w10", "reed@yale.edu");
  const reviewer = await personWithPermission("Robin", "recruitment.review_all");
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id } });
  await releaseDecisions(cycle.id, srr.id);

  await withdrawApplication("w10", ID("reed@yale.edu"));

  expect(await prisma.notification.count({ where: { personId: reviewer.id } })).toBe(1);
});

it("stays silent when the acceptance was recorded but never released", async () => {
  const { srr, app } = await seedCycle("w10b", "reed@yale.edu");
  const reviewer = await personWithPermission("Reese", "recruitment.review_all");
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id } });

  await withdrawApplication("w10b", ID("reed@yale.edu"));

  // The applicant was never told anything, so this is an ordinary under-review
  // withdrawal. Mailing every review_all holder that they "declined their offer"
  // would be both noise and untrue.
  expect(await prisma.notification.count({ where: { personId: reviewer.id } })).toBe(0);
  expect(await prisma.notification.count()).toBe(0);
});

it("does not notify twice when the second withdrawal loses the claim", async () => {
  const { srr, app, cycle } = await seedCycle("w11", "reed@yale.edu");
  const reviewer = await personWithPermission("Rory", "recruitment.review_all");
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id } });
  await releaseDecisions(cycle.id, srr.id);

  await withdrawApplication("w11", ID("reed@yale.edu"));
  await expect(withdrawApplication("w11", ID("reed@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);

  expect(await prisma.notification.count({ where: { personId: reviewer.id } })).toBe(1);
});

it("deletes the draft and its applicant so a fresh application is possible", async () => {
  const { app, applicant, cycle } = await seedCycle("w12", "reed@yale.edu", { appStatus: "DRAFT" });
  await discardDraft("w12", ID("reed@yale.edu"));
  expect(await prisma.application.count({ where: { id: app.id } })).toBe(0);
  expect(await prisma.applicant.count({ where: { id: applicant.id } })).toBe(0);
  // The unique (cycleId, emailLower) slot is free again.
  const fresh = await prisma.applicant.create({
    data: { cycleId: cycle.id, firstName: "Reed", lastName: "Rivers", email: "reed@yale.edu", emailLower: "reed@yale.edu" },
  });
  expect(fresh.id).toBeTruthy();
});

it("refuses to discard a submitted application", async () => {
  const { app } = await seedCycle("w13", "reed@yale.edu");
  await expect(discardDraft("w13", ID("reed@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
  expect(await prisma.application.count({ where: { id: app.id } })).toBe(1);
});

it("refuses once the cycle has closed", async () => {
  const { app } = await seedCycle("w14", "reed@yale.edu", { appStatus: "DRAFT", cycleStatus: "CLOSED" });
  await expect(discardDraft("w14", ID("reed@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
  expect(await prisma.application.count({ where: { id: app.id } })).toBe(1);
});

it("refuses to discard another applicant's draft", async () => {
  const { app } = await seedCycle("w15", "reed@yale.edu", { appStatus: "DRAFT" });
  await expect(discardDraft("w15", ID("intruder@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
  expect(await prisma.application.count({ where: { id: app.id } })).toBe(1);
});

it("discards only the caller's own draft, never a co-applicant's in the same cycle", async () => {
  // discardDraft DELETES, so cross-applicant isolation matters more here than
  // anywhere else in this module, and it shares findOwnApplication with withdraw.
  const { cycle, app: victim, applicant: victimApplicant } = await seedCycle("w15b", "reed@yale.edu", { appStatus: "DRAFT" });
  const { app: mine } = await addApplicant(cycle.id, "blake@yale.edu", { appStatus: "DRAFT" });

  await discardDraft("w15b", ID("blake@yale.edu"));

  expect(await prisma.application.count({ where: { id: mine.id } })).toBe(0);
  expect(await prisma.application.count({ where: { id: victim.id } })).toBe(1);
  expect(await prisma.applicant.count({ where: { id: victimApplicant.id } })).toBe(1);
});

it("drops a withdrawn application out of the review queue and the digest count", async () => {
  const { srr, cycle, app } = await seedCycle("w16", "reed@yale.edu");
  // pendingReviewCount's VOLUNTEER-track branch counts only applications ROUTED to
  // the department (routedDepartmentCode), not merely awaiting routing; seedCycle
  // does not route, so route it here to get a realistic "pending review" fixture.
  await prisma.application.update({ where: { id: app.id }, data: { routedDepartmentCode: "SRHD" } });
  expect(await listApplicantsForReview(cycle.id, srr.id)).toHaveLength(1);
  expect(await pendingReviewCount(["SRHD"])).toBe(1);

  await withdrawApplication("w16", ID("reed@yale.edu"));

  expect(await listApplicantsForReview(cycle.id, srr.id)).toHaveLength(0);
  expect(await pendingReviewCount(["SRHD"])).toBe(0);
});

it("keeps a withdrawn applicant's interview visible to the panel, marked withdrawn", async () => {
  const { srr, app } = await seedCycle("w17", "reed@yale.edu");
  const panelist = await prisma.person.create({
    data: { name: "Pat Panel", status: "ACTIVE", contactEmail: "pat2@yale.edu" },
  });
  const iv = await prisma.interview.create({
    data: { applicationId: app.id, departmentCode: "SRHD", createdById: srr.id, scheduledAt: new Date() },
  });
  await prisma.interviewPanelist.create({ data: { interviewId: iv.id, personId: panelist.id } });

  await withdrawApplication("w17", ID("reed@yale.edu"));

  const mine = await myAssignedInterviews(panelist.id);
  expect(mine).toHaveLength(1);
  expect(mine[0].application.status).toBe("WITHDRAWN");
});

it("reopens a withdrawn application back to SUBMITTED and clears the stamp", async () => {
  const { srr, app, cycle } = await seedCycle("w18", "reed@yale.edu");
  const manager = await personWithPermission("Morgan", "recruitment.manage_cycles");
  await withdrawApplication("w18", ID("reed@yale.edu"));

  await reopenWithdrawnApplication(app.id, manager.id);

  const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  expect(after.status).toBe("SUBMITTED");
  expect(after.withdrawnAt).toBeNull();
  expect(await listApplicantsForReview(cycle.id, srr.id)).toHaveLength(1);
});

it("refuses to reopen without recruitment.manage_cycles", async () => {
  const { app } = await seedCycle("w19", "reed@yale.edu");
  const nobody = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });
  await withdrawApplication("w19", ID("reed@yale.edu"));
  await expect(reopenWithdrawnApplication(app.id, nobody.id)).rejects.toBeInstanceOf(WithdrawError);
  expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).status).toBe("WITHDRAWN");
});

it("refuses to reopen an application that was never withdrawn", async () => {
  const { app } = await seedCycle("w20", "reed@yale.edu");
  const manager = await personWithPermission("Marley", "recruitment.manage_cycles");
  await expect(reopenWithdrawnApplication(app.id, manager.id)).rejects.toBeInstanceOf(WithdrawError);
});

it("refuses to promote an applicant who withdrew after submitting their contract", async () => {
  const { srr, app, cycle } = await seedCycle("w21", "reed@yale.edu");
  const acc = await prisma.acceptance.create({
    data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id },
  });
  await releaseDecisions(cycle.id, srr.id);
  const contract = await createOrResendContract(acc.id, srr.id, "http://test");
  // The applicant filled the contract in, then changed their mind.
  await prisma.onboardingContract.update({
    where: { id: contract.id },
    data: { status: "SUBMITTED", submittedAt: new Date() },
  });
  await withdrawApplication("w21", ID("reed@yale.edu"));

  const res = await promoteContracts([contract.id], srr.id);

  expect(res.created).toBe(0);
  expect(res.skipped).toBe(1);
  const after = await prisma.onboardingContract.findUniqueOrThrow({ where: { id: contract.id } });
  expect(after.status).toBe("SUBMITTED");
  expect(after.promotedPersonId).toBeNull();
});

it("still promotes an applicant who did not withdraw", async () => {
  const { srr, app, cycle } = await seedCycle("w22", "dana@yale.edu");
  const acc = await prisma.acceptance.create({
    data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id },
  });
  await releaseDecisions(cycle.id, srr.id);
  const contract = await createOrResendContract(acc.id, srr.id, "http://test");
  await prisma.onboardingContract.update({
    where: { id: contract.id },
    data: { status: "SUBMITTED", submittedAt: new Date() },
  });

  const res = await promoteContracts([contract.id], srr.id);

  expect(res.skipped).toBe(0);
  expect(res.created + res.reactivated).toBe(1);
});
