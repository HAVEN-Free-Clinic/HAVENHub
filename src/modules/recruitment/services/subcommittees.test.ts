import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle } from "./cycles";
import {
  assignSubcommittees, listAcceptedForAssignment, SubcommitteeAssignError,
} from "./subcommittees";
import { RecruitmentAuthError } from "./review";

function accept(applicationId: string, departmentCode: string, approvedById: string) {
  return prisma.acceptance.create({ data: { applicationId, departmentCode, approvedById } });
}

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
  return { lead, term, cycle, app, sub };
}

/** A second accepted-or-not application in the same cycle. */
async function anotherApp(cycleId: string, email: string) {
  const applicant = await prisma.applicant.create({ data: { cycleId, firstName: "Bo", lastName: "Kim", email, emailLower: email } });
  return prisma.application.create({ data: { cycleId, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD"] } });
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("refuses to assign before the applicant is accepted", async () => {
  const { lead, cycle, app, sub } = await seed();
  await expect(assignSubcommittees(cycle.id, [{ applicationId: app.id, subcommitteeId: sub.id }], lead.id))
    .rejects.toBeInstanceOf(SubcommitteeAssignError);
});

it("assigns a subcommittee to an accepted applicant and records who/when", async () => {
  const { lead, cycle, app, sub } = await seed();
  await accept(app.id, "SRHD", lead.id);
  await assignSubcommittees(cycle.id, [{ applicationId: app.id, subcommitteeId: sub.id }], lead.id);
  const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  expect(after.assignedSubcommitteeId).toBe(sub.id);
  expect(after.assignedSubcommitteeById).toBe(lead.id);
  expect(after.assignedSubcommitteeAt).not.toBeNull();
});

it("clears an assignment with null", async () => {
  const { lead, cycle, app, sub } = await seed();
  await accept(app.id, "SRHD", lead.id);
  await assignSubcommittees(cycle.id, [{ applicationId: app.id, subcommitteeId: sub.id }], lead.id);
  await assignSubcommittees(cycle.id, [{ applicationId: app.id, subcommitteeId: null }], lead.id);
  const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  expect(after.assignedSubcommitteeId).toBeNull();
  expect(after.assignedSubcommitteeById).toBeNull();
  expect(after.assignedSubcommitteeAt).toBeNull();
});

it("rejects a non-lead caller", async () => {
  const { cycle, app, sub } = await seed();
  const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: outsider.id } });
  await expect(assignSubcommittees(cycle.id, [{ applicationId: app.id, subcommitteeId: sub.id }], outsider.id))
    .rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("saves several applicants in one call, with an audit row for each", async () => {
  const { lead, cycle, app, sub } = await seed();
  const second = await anotherApp(cycle.id, "bo@yale.edu");
  await accept(app.id, "SRHD", lead.id);
  await accept(second.id, "SRHD", lead.id);

  const saved = await assignSubcommittees(
    cycle.id,
    [{ applicationId: app.id, subcommitteeId: sub.id }, { applicationId: second.id, subcommitteeId: sub.id }],
    lead.id,
  );

  expect(saved).toBe(2);
  const rows = await prisma.application.findMany({ where: { id: { in: [app.id, second.id] } } });
  expect(rows.map((r) => r.assignedSubcommitteeId)).toEqual([sub.id, sub.id]);
  expect(await prisma.auditLog.count({ where: { action: "recruitment.subcommittee_assign" } })).toBe(2);
});

it("writes nothing when any one change in the batch is invalid", async () => {
  // The page sends every changed row at once. A row that fails must not leave
  // the rows before it saved, or the table no longer matches what was submitted.
  const { lead, cycle, app, sub } = await seed();
  const notAccepted = await anotherApp(cycle.id, "bo@yale.edu");
  await accept(app.id, "SRHD", lead.id);

  await expect(
    assignSubcommittees(
      cycle.id,
      [{ applicationId: app.id, subcommitteeId: sub.id }, { applicationId: notAccepted.id, subcommitteeId: sub.id }],
      lead.id,
    ),
  ).rejects.toBeInstanceOf(SubcommitteeAssignError);

  const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  expect(after.assignedSubcommitteeId).toBeNull();
  expect(await prisma.auditLog.count({ where: { action: "recruitment.subcommittee_assign" } })).toBe(0);
});

it("refuses an application from another cycle", async () => {
  const { lead, term, app, sub } = await seed();
  await accept(app.id, "SRHD", lead.id);
  const other = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "W", publicSlug: "apply-y", departments: ["SRHD"], acceptsRenewals: false, createdById: lead.id });
  await expect(assignSubcommittees(other.id, [{ applicationId: app.id, subcommitteeId: sub.id }], lead.id))
    .rejects.toBeInstanceOf(SubcommitteeAssignError);
});

it("refuses an inactive subcommittee", async () => {
  const { lead, cycle, app } = await seed();
  await accept(app.id, "SRHD", lead.id);
  const retired = await prisma.subcommittee.create({ data: { name: "Retired", isActive: false } });
  await expect(assignSubcommittees(cycle.id, [{ applicationId: app.id, subcommitteeId: retired.id }], lead.id))
    .rejects.toBeInstanceOf(SubcommitteeAssignError);
});

it("lists accepted applicants with resolved ranking + current assignment", async () => {
  const { lead, cycle, app, sub } = await seed();
  await accept(app.id, "SRHD", lead.id);
  await assignSubcommittees(cycle.id, [{ applicationId: app.id, subcommitteeId: sub.id }], lead.id);
  const rows = await listAcceptedForAssignment(cycle.id, lead.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].acceptedDepartments).toEqual(["SRHD"]);
  expect(rows[0].ranking.map((r) => r.name)).toEqual(["Outreach"]);
  expect(rows[0].assignedSubcommitteeId).toBe(sub.id);
  expect(rows[0].assignedSubcommittee).toEqual({ id: sub.id, name: "Outreach", active: true });
});

it("still names an assignment whose subcommittee was deactivated after", async () => {
  // The page keeps this as the row's selected option. Unresolved, the row would
  // read "Unassigned" and the next Save would clear it.
  const { lead, cycle, app, sub } = await seed();
  await accept(app.id, "SRHD", lead.id);
  await assignSubcommittees(cycle.id, [{ applicationId: app.id, subcommitteeId: sub.id }], lead.id);
  await prisma.subcommittee.update({ where: { id: sub.id }, data: { isActive: false } });
  await prisma.application.update({ where: { id: app.id }, data: { subcommitteeRanking: [] } });

  const [row] = await listAcceptedForAssignment(cycle.id, lead.id);
  expect(row.assignedSubcommittee).toEqual({ id: sub.id, name: "Outreach", active: false });
});

it("listAcceptedForAssignment rejects a non-lead viewer", async () => {
  const { cycle } = await seed();
  const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
  await expect(listAcceptedForAssignment(cycle.id, outsider.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});
