import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getApplicantStatus } from "./portal-status";
import { releaseDecisions } from "./decisions";
import { createOrResendContract } from "./onboarding";

function accept(applicationId: string, departmentCode: string, approvedById: string) {
  return prisma.acceptance.create({ data: { applicationId, departmentCode, approvedById } });
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function cycleWithApp(
  slug: string,
  email: string,
  opts: { appStatus?: "DRAFT" | "SUBMITTED"; cycleStatus?: "OPEN" | "CLOSED"; closesAt?: Date | null } = {},
) {
  const appStatus = opts.appStatus ?? "SUBMITTED";
  const cycleStatus = opts.cycleStatus ?? "OPEN";
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "RA " + slug, grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "F", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "SRHD", name: "Student Run Health Dept" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "Volunteer 2026", publicSlug: slug, departments: ["SRHD"], createdById: srr.id, status: cycleStatus, closesAt: opts.closesAt ?? null } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Reed", lastName: "R", email, emailLower: email.toLowerCase() } });
  const app = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD"], status: appStatus, submittedAt: appStatus === "SUBMITTED" ? new Date() : null } });
  return { srr, cycle, applicant, app };
}
const ID = (email: string) => ({ email, personId: null });

it("shows Submitted / under review before any decision", async () => {
  await cycleWithApp("c1", "reed@yale.edu");
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  expect(v.state).toBe("SUBMITTED");
});

it("shows Accepted only after the acceptance email is sent (released)", async () => {
  const { srr, app } = await cycleWithApp("c2", "reed@yale.edu");
  await accept(app.id, "SRHD", srr.id);
  // Accepted but not yet released: still neutral.
  expect((await getApplicantStatus(ID("reed@yale.edu")))[0].state).toBe("SUBMITTED");
  await releaseDecisions((await prisma.recruitmentCycle.findFirstOrThrow({ where: { publicSlug: "c2" } })).id, srr.id);
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  expect(v.state).toBe("ACCEPTED");
  expect(v.headline).toContain("Student Run Health Dept");
});

it("shows Not selected only after decisions are released", async () => {
  const { srr, cycle } = await cycleWithApp("c3", "reed@yale.edu");
  expect((await getApplicantStatus(ID("reed@yale.edu")))[0].state).toBe("SUBMITTED");
  await releaseDecisions(cycle.id, srr.id);
  expect((await getApplicantStatus(ID("reed@yale.edu")))[0].state).toBe("NOT_SELECTED");
});

it("shows Onboarding once a contract exists", async () => {
  const { srr, app, cycle } = await cycleWithApp("c4", "reed@yale.edu");
  const acc = await accept(app.id, "SRHD", srr.id);
  await releaseDecisions(cycle.id, srr.id);
  await createOrResendContract(acc.id, srr.id, "http://test");
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  expect(v.state).toBe("ONBOARDING");
});

it("shows a scheduled interview as neutral progress", async () => {
  const { app } = await cycleWithApp("c5", "reed@yale.edu");
  await prisma.interview.create({ data: { applicationId: app.id, departmentCode: "SRHD", scheduledAt: new Date("2026-09-01T14:00:00Z"), createdById: (await prisma.person.findFirstOrThrow()).id } });
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  expect(v.state).toBe("INTERVIEW");
});

it("lets you continue a draft while the cycle is open", async () => {
  await cycleWithApp("d1", "reed@yale.edu", { appStatus: "DRAFT" });
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  expect(v.state).toBe("DRAFT");
  expect(v.canContinue).toBe(true);
});

it("does not offer Continue for a draft whose cycle has closed", async () => {
  await cycleWithApp("d2", "reed@yale.edu", { appStatus: "DRAFT", cycleStatus: "CLOSED" });
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  expect(v.canContinue).toBe(false);
  expect(v.headline).toMatch(/closed/i);
});

it("does not offer Continue for a draft whose application window has passed", async () => {
  await cycleWithApp("d3", "reed@yale.edu", { appStatus: "DRAFT", closesAt: new Date("2020-01-01T00:00:00Z") });
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  expect(v.canContinue).toBe(false);
});

it("does not leak another identity's status", async () => {
  await cycleWithApp("c6", "reed@yale.edu");
  expect(await getApplicantStatus(ID("other@yale.edu"))).toEqual([]);
});

it("does not show NOT_SELECTED for a released cycle where acceptances exist but none is emailed (conflict case)", async () => {
  const { srr, cycle, app } = await cycleWithApp("c7", "reed@yale.edu");
  // Create an un-emailed acceptance row directly (simulates conflict: accepted by 2+ depts, email withheld).
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id, emailedAt: null } });
  // Mark the cycle as released without going through releaseDecisions (which would send the email).
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { decisionsReleasedAt: new Date() } });
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  // Conflicted applicant must see neutral SUBMITTED, not a false rejection.
  expect(v.state).toBe("SUBMITTED");
});

it("does not show NOT_SELECTED for an application submitted after decisions were released (audit3 M2)", async () => {
  const { cycle, app } = await cycleWithApp("c8", "late@yale.edu");
  // Release is allowed on an OPEN cycle and is repeatable/survives reopen, so an
  // application submitted after a release must not inherit a false rejection.
  const releasedAt = new Date("2026-06-01T00:00:00Z");
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { decisionsReleasedAt: releasedAt } });
  await prisma.application.update({ where: { id: app.id }, data: { submittedAt: new Date("2026-06-02T00:00:00Z") } });
  const [v] = await getApplicantStatus(ID("late@yale.edu"));
  expect(v.state).toBe("SUBMITTED");
});

it("shows NOT_SELECTED for an application submitted at/before the release (audit3 M2)", async () => {
  const { cycle, app } = await cycleWithApp("c9", "early@yale.edu");
  await prisma.application.update({ where: { id: app.id }, data: { submittedAt: new Date("2026-06-01T00:00:00Z") } });
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { decisionsReleasedAt: new Date("2026-06-05T00:00:00Z") } });
  const [v] = await getApplicantStatus(ID("early@yale.edu"));
  expect(v.state).toBe("NOT_SELECTED");
});

