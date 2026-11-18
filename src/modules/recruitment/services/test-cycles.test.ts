import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle } from "./cycles";
import { createTestCycle, deleteTestCycle, TestCycleError, TEST_TITLE_PREFIX } from "./test-cycles";
import { setTrainingCycle, TrainingStateError } from "./training";
import { resolveCycleEmail, renderResolvedEmail } from "../email/render";
import { liveAcceptanceWhere } from "@/platform/recruitment/incoming-roster";

// Same grant pattern as cycle-emails.test.ts: a role with the permission,
// assigned globally (termId null).
async function manager() {
  const p = await prisma.person.create({ data: { name: "Mgr", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Mgr", isSystem: false, grants: { create: [{ permission: "recruitment.manage_cycles" }] } },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: p.id, termId: null } });
  return p;
}

async function realCycle(createdById: string) {
  const term = await prisma.term.create({
    data: { code: "SP27", name: "Spring 2027", startDate: new Date(), endDate: new Date() },
  });
  return createCycle({
    track: "DIRECTOR", termId: term.id, title: "Spring Director 2027", publicSlug: "spring-director-2027",
    departments: ["SRHD"], acceptsRenewals: true, createdById,
  });
}

async function applyTo(cycleId: string, email: string) {
  const applicant = await prisma.applicant.create({
    data: { cycleId, firstName: "Test", lastName: "Person", email, emailLower: email.toLowerCase() },
  });
  return prisma.application.create({
    data: { cycleId, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD"] },
  });
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("createTestCycle", () => {
  it("copies the form, email overrides, contract and settings into a draft marked as a test", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    await prisma.recruitmentCycleEmail.create({
      data: { cycleId: source.id, key: "recruitment.acceptance", subject: "Welcome", body: "<p>Hi</p>" },
    });
    await prisma.recruitmentCycleContract.create({ data: { cycleId: source.id, layout: { blocks: ["a"] } } });

    const copy = await createTestCycle(source.id, mgr.id);

    expect(copy.isTest).toBe(true);
    expect(copy.testSourceCycleId).toBe(source.id);
    expect(copy.status).toBe("DRAFT");
    expect(copy.isTermTraining).toBe(false);
    expect(copy.title).toBe(`${TEST_TITLE_PREFIX}Spring Director 2027`);
    expect(copy.publicSlug).toMatch(/^spring-director-2027-test-[0-9a-f]{6}$/);
    expect(copy.acceptsRenewals).toBe(true);
    expect(copy.departments).toEqual(["SRHD"]);

    const fieldsOf = (cycleId: string) =>
      prisma.formField.findMany({ where: { cycleId }, orderBy: { order: "asc" }, select: { key: true, label: true, type: true, required: true } });
    expect(await fieldsOf(copy.id)).toEqual(await fieldsOf(source.id));
    // The copy's fields hang off the copy's own sections, not the source's.
    const copiedSectionIds = new Set((await prisma.formSection.findMany({ where: { cycleId: copy.id } })).map((s) => s.id));
    const copiedFields = await prisma.formField.findMany({ where: { cycleId: copy.id } });
    expect(copiedFields.every((f) => copiedSectionIds.has(f.sectionId))).toBe(true);

    expect(await prisma.recruitmentCycleEmail.findMany({ where: { cycleId: copy.id }, select: { key: true, subject: true } }))
      .toEqual([{ key: "recruitment.acceptance", subject: "Welcome" }]);
    expect((await prisma.recruitmentCycleContract.findUnique({ where: { cycleId: copy.id } }))?.layout).toEqual({ blocks: ["a"] });
  });

  it("copies no applicants", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    await applyTo(source.id, "real@yale.edu");
    const copy = await createTestCycle(source.id, mgr.id);
    expect(await prisma.application.count({ where: { cycleId: copy.id } })).toBe(0);
    expect(await prisma.applicant.count({ where: { cycleId: copy.id } })).toBe(0);
  });

  it("refuses someone without manage_cycles", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
    await expect(createTestCycle(source.id, outsider.id)).rejects.toBeInstanceOf(TestCycleError);
  });

  it("refuses to copy a test run", async () => {
    const mgr = await manager();
    const copy = await createTestCycle((await realCycle(mgr.id)).id, mgr.id);
    await expect(createTestCycle(copy.id, mgr.id)).rejects.toBeInstanceOf(TestCycleError);
  });

  it("gives two test runs of the same cycle different links", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    const a = await createTestCycle(source.id, mgr.id);
    const b = await createTestCycle(source.id, mgr.id);
    expect(a.publicSlug).not.toBe(b.publicSlug);
  });
});

describe("what a test run cannot touch", () => {
  it("prefixes every email subject with [TEST], and only on the test run", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    const copy = await createTestCycle(source.id, mgr.id);

    const real = renderResolvedEmail(await resolveCycleEmail(source.id, "recruitment.rejection"), { firstName: "A" });
    const test = renderResolvedEmail(await resolveCycleEmail(copy.id, "recruitment.rejection"), { firstName: "A" });
    expect(real.subject.startsWith("[TEST]")).toBe(false);
    expect(test.subject).toBe(`[TEST] ${real.subject}`);
  });

  it("keeps the prefix out of the source the email editor shows and saves", async () => {
    const mgr = await manager();
    const copy = await createTestCycle((await realCycle(mgr.id)).id, mgr.id);
    const sources = await resolveCycleEmail(copy.id, "recruitment.rejection");
    expect(sources.subjectSource.startsWith("[TEST]")).toBe(false);
  });

  it("can never be the term's training cycle", async () => {
    const mgr = await manager();
    const copy = await createTestCycle((await realCycle(mgr.id)).id, mgr.id);
    await expect(setTrainingCycle(copy.id, true, mgr.id)).rejects.toBeInstanceOf(TrainingStateError);
  });

  it("keeps its acceptances off the incoming roster", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    const copy = await createTestCycle(source.id, mgr.id);
    const realApp = await applyTo(source.id, "real@yale.edu");
    const testApp = await applyTo(copy.id, "fake@yale.edu");
    await prisma.acceptance.create({ data: { applicationId: realApp.id, departmentCode: "SRHD", approvedById: mgr.id } });
    await prisma.acceptance.create({ data: { applicationId: testApp.id, departmentCode: "SRHD", approvedById: mgr.id } });

    const live = await prisma.acceptance.findMany({ where: liveAcceptanceWhere(), select: { applicationId: true } });
    expect(live.map((a) => a.applicationId)).toEqual([realApp.id]);
  });
});

describe("deleteTestCycle", () => {
  it("deletes the test run and everyone in it, and leaves the real cycle alone", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    await applyTo(source.id, "real@yale.edu");
    const copy = await createTestCycle(source.id, mgr.id);
    const fake = await applyTo(copy.id, "fake@yale.edu");
    await prisma.acceptance.create({ data: { applicationId: fake.id, departmentCode: "SRHD", approvedById: mgr.id } });

    expect(await deleteTestCycle(copy.id, mgr.id)).toEqual({ sourceCycleId: source.id });

    expect(await prisma.recruitmentCycle.findUnique({ where: { id: copy.id } })).toBeNull();
    expect(await prisma.application.count({ where: { cycleId: copy.id } })).toBe(0);
    expect(await prisma.formField.count({ where: { cycleId: copy.id } })).toBe(0);
    expect(await prisma.recruitmentCycle.findUnique({ where: { id: source.id } })).not.toBeNull();
    expect(await prisma.application.count({ where: { cycleId: source.id } })).toBe(1);
  });

  it("refuses to delete a real cycle", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    await expect(deleteTestCycle(source.id, mgr.id)).rejects.toBeInstanceOf(TestCycleError);
    expect(await prisma.recruitmentCycle.findUnique({ where: { id: source.id } })).not.toBeNull();
  });

  it("refuses someone without manage_cycles", async () => {
    const mgr = await manager();
    const copy = await createTestCycle((await realCycle(mgr.id)).id, mgr.id);
    const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
    await expect(deleteTestCycle(copy.id, outsider.id)).rejects.toBeInstanceOf(TestCycleError);
  });
});
