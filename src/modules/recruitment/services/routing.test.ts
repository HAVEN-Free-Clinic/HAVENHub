import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { routeApplication, decideRoutedApplication, RoutingError } from "./routing";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  await prisma.department.create({ data: { code: "MDIC", name: "Medical" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const other = await prisma.person.create({ data: { name: "Other", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "SRR", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC", "MDIC"], createdById: lead.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email: "a@y.edu", emailLower: "a@y.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  return { lead, other, application };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("routeApplication", () => {
  it("lets a lead route to any cycle department (even off-choice) and audits", async () => {
    const { lead, application } = await seed();
    const routed = await routeApplication(application.id, "MDIC", lead.id); // MDIC not in departmentChoices
    expect(routed.routedDepartmentCode).toBe("MDIC");
    expect(routed.routedById).toBe(lead.id);
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.route" } });
    expect(audit).not.toBeNull();
  });

  it("rejects a non-lead", async () => {
    const { other, application } = await seed();
    await expect(routeApplication(application.id, "EDUC", other.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("rejects a department not in the cycle", async () => {
    const { lead, application } = await seed();
    await expect(routeApplication(application.id, "NOPE", lead.id)).rejects.toBeInstanceOf(RoutingError);
  });

  it("rejects routing a director-track application (routing is volunteer-only)", async () => {
    const { lead } = await seed();
    // The director track keeps its ranked-choice flow; it must never be routed.
    const term = await prisma.term.findFirstOrThrow();
    const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["EDUC", "MDIC"], createdById: lead.id, status: "OPEN" } });
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "D", lastName: "R", email: "dr@y.edu", emailLower: "dr@y.edu" } });
    const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
    await expect(routeApplication(application.id, "EDUC", lead.id)).rejects.toBeInstanceOf(RoutingError);
  });
});

describe("decideRoutedApplication", () => {
  it("accepts a routed application: mints an Acceptance, sets Application.decision, audits", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    const decided = await decideRoutedApplication(application.id, "ACCEPT", lead.id, "great fit");
    expect(decided.decision).toBe("ACCEPT");
    const acc = await prisma.acceptance.findFirst({ where: { applicationId: application.id, departmentCode: "EDUC" } });
    expect(acc).not.toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.application_decide" } });
    expect(audit).not.toBeNull();
  });

  it("waitlist/reject sets the decision + notes without an Acceptance", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    const decided = await decideRoutedApplication(application.id, "WAITLIST", lead.id, "maybe next cycle");
    expect(decided.decision).toBe("WAITLIST");
    expect(decided.decisionNotes).toBe("maybe next cycle");
    expect(await prisma.acceptance.findMany({ where: { applicationId: application.id } })).toHaveLength(0);
  });

  it("removes a not-yet-emailed Acceptance when changing away from ACCEPT", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await decideRoutedApplication(application.id, "ACCEPT", lead.id, null);
    await decideRoutedApplication(application.id, "REJECT", lead.id, null);
    expect(await prisma.acceptance.findMany({ where: { applicationId: application.id } })).toHaveLength(0);
  });

  it("rejects deciding an application that hasn't been routed", async () => {
    const { lead, application } = await seed();
    await expect(decideRoutedApplication(application.id, "ACCEPT", lead.id, null)).rejects.toBeInstanceOf(RoutingError);
  });

  it("rejects a decider outside the routed department's scope", async () => {
    const { lead, other, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await expect(decideRoutedApplication(application.id, "ACCEPT", other.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("rejects self-deciding (separation of duties)", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await prisma.applicant.update({ where: { id: application.applicantId }, data: { applicantPersonId: lead.id } });
    await expect(decideRoutedApplication(application.id, "ACCEPT", lead.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });
});
