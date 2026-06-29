import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle } from "./cycles";
import { acceptApplicant } from "./review";
import {
  assignSubcommittee, listAcceptedForAssignment, SubcommitteeAssignError,
} from "./subcommittees";
import { RecruitmentAuthError } from "./review";

async function seed() {
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  // grant review_all so the lead is "seeAll"
  const role = await prisma.role.create({ data: { name: "SRR Lead", isSystem: false, grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: lead.id, termId: null } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "apply-x", departments: ["SRHD"], acceptsRenewals: false, createdById: lead.id });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Ann", lastName: "Lee", email: "ann@yale.edu", emailLower: "ann@yale.edu" } });
  const sub = await prisma.subcommittee.create({ data: { name: "Outreach" } });
  const app = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD"], subcommitteeRanking: [sub.id] } });
  return { lead, cycle, app, sub };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("refuses to assign before the applicant is accepted", async () => {
  const { lead, app, sub } = await seed();
  await expect(assignSubcommittee(app.id, sub.id, lead.id)).rejects.toBeInstanceOf(SubcommitteeAssignError);
});

it("assigns a subcommittee to an accepted applicant and records who/when", async () => {
  const { lead, app, sub } = await seed();
  await acceptApplicant(app.id, "SRHD", lead.id, null);
  await assignSubcommittee(app.id, sub.id, lead.id);
  const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  expect(after.assignedSubcommitteeId).toBe(sub.id);
  expect(after.assignedSubcommitteeById).toBe(lead.id);
  expect(after.assignedSubcommitteeAt).not.toBeNull();
});

it("clears an assignment with null", async () => {
  const { lead, app, sub } = await seed();
  await acceptApplicant(app.id, "SRHD", lead.id, null);
  await assignSubcommittee(app.id, sub.id, lead.id);
  await assignSubcommittee(app.id, null, lead.id);
  const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  expect(after.assignedSubcommitteeId).toBeNull();
  expect(after.assignedSubcommitteeById).toBeNull();
  expect(after.assignedSubcommitteeAt).toBeNull();
});

it("rejects a non-lead caller", async () => {
  const { app, sub } = await seed();
  const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: outsider.id } });
  await expect(assignSubcommittee(app.id, sub.id, outsider.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("lists accepted applicants with resolved ranking + current assignment", async () => {
  const { lead, cycle, app, sub } = await seed();
  await acceptApplicant(app.id, "SRHD", lead.id, null);
  await assignSubcommittee(app.id, sub.id, lead.id);
  const rows = await listAcceptedForAssignment(cycle.id, lead.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].acceptedDepartments).toEqual(["SRHD"]);
  expect(rows[0].ranking.map((r) => r.name)).toEqual(["Outreach"]);
  expect(rows[0].assignedSubcommitteeId).toBe(sub.id);
});

it("listAcceptedForAssignment rejects a non-lead viewer", async () => {
  const { cycle } = await seed();
  const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
  await expect(listAcceptedForAssignment(cycle.id, outsider.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});
