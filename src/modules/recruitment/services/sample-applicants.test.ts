import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { SAMPLE_EMAIL_DOMAIN } from "@/platform/email/address";
import { createCycle } from "./cycles";
import { createTestCycle } from "./test-cycles";
import { addSampleApplicants, SAMPLE_APPLICANT_COUNT, SampleApplicantsError } from "./sample-applicants";

// Same grant pattern as test-cycles.test.ts.
async function manager() {
  const p = await prisma.person.create({ data: { name: "Mgr", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Mgr", isSystem: false, grants: { create: [{ permission: "recruitment.manage_cycles" }] } },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: p.id, termId: null } });
  return p;
}

// A volunteer cycle with the full default form, so the samples answer a real one.
async function realCycle(createdById: string, opts: { acceptsRenewals?: boolean; departments?: string[] } = {}) {
  const term = await prisma.term.create({
    data: { code: "SP27", name: "Spring 2027", startDate: new Date(), endDate: new Date() },
  });
  return createCycle({
    track: "VOLUNTEER", termId: term.id, title: "Spring Volunteer 2027", publicSlug: "spring-volunteer-2027",
    departments: opts.departments ?? ["SRHD", "MDIC"], acceptsRenewals: opts.acceptsRenewals ?? true, createdById,
  }, true);
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("addSampleApplicants", () => {
  it("adds 20 different submitted applicants with a mix of types and departments", async () => {
    const mgr = await manager();
    const test = await createTestCycle((await realCycle(mgr.id)).id, mgr.id);

    expect(await addSampleApplicants(test.id, mgr.id)).toBe(SAMPLE_APPLICANT_COUNT);

    const apps = await prisma.application.findMany({ where: { cycleId: test.id }, include: { applicant: true } });
    expect(apps).toHaveLength(20);
    expect(new Set(apps.map((a) => `${a.applicant.firstName} ${a.applicant.lastName}`)).size).toBe(20);
    expect(new Set(apps.map((a) => a.applicant.emailLower)).size).toBe(20);
    expect(apps.every((a) => a.status === "SUBMITTED" && a.submittedAt)).toBe(true);
    expect(new Set(apps.map((a) => a.applicantType))).toEqual(new Set(["NEW", "RENEWAL", "TRANSFER"]));
    expect(new Set(apps.flatMap((a) => a.departmentChoices))).toEqual(new Set(["SRHD", "MDIC"]));
    expect(apps.some((a) => a.applicant.firstName === "Beyoncé" && a.applicant.lastName === "Knowles")).toBe(true);

    // A renewal goes back to its department, like a real one.
    for (const a of apps.filter((x) => x.applicantType === "RENEWAL")) {
      expect(a.renewalDepartment).toBeTruthy();
      expect(a.routedDepartmentCode).toBe(a.renewalDepartment);
    }
    // A transfer is coming from a department other than the one it picked.
    for (const a of apps.filter((x) => x.applicantType === "TRANSFER")) {
      expect(a.transferFromDepartments).toHaveLength(1);
      expect(a.departmentChoices).not.toContain(a.transferFromDepartments[0]);
    }
    // New applicants answered the identity questions.
    const fresh = apps.find((a) => a.applicantType === "NEW")!;
    const answers = fresh.answers as Record<string, unknown>;
    expect(answers.first_name).toBe(fresh.applicant.firstName);
    expect(answers.email).toBe(fresh.applicant.email);
  });

  it("never links a sample to a real person or NetID, and uses only the sample email domain", async () => {
    const mgr = await manager();
    const test = await createTestCycle((await realCycle(mgr.id)).id, mgr.id);
    await addSampleApplicants(test.id, mgr.id);

    const applicants = await prisma.applicant.findMany({ where: { cycleId: test.id } });
    expect(applicants.every((a) => a.netId === null && a.applicantPersonId === null)).toBe(true);
    expect(applicants.every((a) => a.emailLower.endsWith(`@${SAMPLE_EMAIL_DOMAIN}`))).toBe(true);
  });

  it("records each confirmation email but sends none", async () => {
    const mgr = await manager();
    const test = await createTestCycle((await realCycle(mgr.id)).id, mgr.id);
    await addSampleApplicants(test.id, mgr.id);

    const emails = await prisma.emailLog.findMany({ where: { toEmail: { endsWith: `@${SAMPLE_EMAIL_DOMAIN}` } } });
    expect(emails).toHaveLength(20);
    expect(emails.every((e) => e.status === "SKIPPED")).toBe(true);
    expect(emails.every((e) => e.subject.startsWith("[TEST] "))).toBe(true);
  });

  it("makes everyone a new applicant when the cycle takes no returning applicants", async () => {
    const mgr = await manager();
    const test = await createTestCycle((await realCycle(mgr.id, { acceptsRenewals: false })).id, mgr.id);
    await addSampleApplicants(test.id, mgr.id);

    const types = await prisma.application.findMany({ where: { cycleId: test.id }, select: { applicantType: true } });
    expect(types.every((t) => t.applicantType === "NEW")).toBe(true);
  });

  it("refuses a real cycle", async () => {
    const mgr = await manager();
    const real = await realCycle(mgr.id);
    await expect(addSampleApplicants(real.id, mgr.id)).rejects.toBeInstanceOf(SampleApplicantsError);
    expect(await prisma.applicant.count({ where: { cycleId: real.id } })).toBe(0);
  });

  it("refuses a second fill so nobody is added twice", async () => {
    const mgr = await manager();
    const test = await createTestCycle((await realCycle(mgr.id)).id, mgr.id);
    await addSampleApplicants(test.id, mgr.id);
    await expect(addSampleApplicants(test.id, mgr.id)).rejects.toBeInstanceOf(SampleApplicantsError);
    expect(await prisma.applicant.count({ where: { cycleId: test.id } })).toBe(20);
  });

  it("refuses someone without recruitment access", async () => {
    const mgr = await manager();
    const test = await createTestCycle((await realCycle(mgr.id)).id, mgr.id);
    const outsider = await prisma.person.create({ data: { name: "Nope", status: "ACTIVE" } });
    await expect(addSampleApplicants(test.id, outsider.id)).rejects.toBeInstanceOf(SampleApplicantsError);
  });
});
