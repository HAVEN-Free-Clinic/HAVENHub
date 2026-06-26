// src/modules/recruitment/services/portal-status.test.ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { listApplicantApplications, getApplicantStatus } from "./portal-status";
import { acceptApplicant } from "./review";
import { releaseDecisions } from "./decisions";
import { createOrResendContract } from "./onboarding";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function cycleWithApp(slug: string, email: string) {
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "RA " + slug, grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "F", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "SRHD", name: "Student Run Health Dept" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "Volunteer 2026", publicSlug: slug, departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Reed", lastName: "R", email, emailLower: email.toLowerCase() } });
  const app = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD"], status: "SUBMITTED", submittedAt: new Date() } });
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
  await acceptApplicant(app.id, "SRHD", srr.id, null);
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
  const acc = await acceptApplicant(app.id, "SRHD", srr.id, null);
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

it("does not leak another identity's status", async () => {
  await cycleWithApp("c6", "reed@yale.edu");
  expect(await getApplicantStatus(ID("other@yale.edu"))).toEqual([]);
});

it("lists the identity's applications across cycles with status", async () => {
  const lead = await prisma.person.create({ data: { name: "L", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "F", startDate: new Date(), endDate: new Date() } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "Volunteer 2026", publicSlug: "v26", departments: ["SRHD"], createdById: lead.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "", lastName: "", email: "reed@yale.edu", emailLower: "reed@yale.edu" } });
  await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: [], subcommitteeRanking: [], status: "DRAFT" } });

  const rows = await listApplicantApplications({ email: "reed@yale.edu", personId: null });
  expect(rows).toEqual([{ slug: "v26", cycleTitle: "Volunteer 2026", status: "DRAFT" }]);
  expect(await listApplicantApplications({ email: "nobody@yale.edu", personId: null })).toEqual([]);
});
