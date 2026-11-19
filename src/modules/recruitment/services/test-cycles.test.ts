import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle } from "./cycles";
import { createTestCycle, deleteTestCycle, resyncTestCycle, syncTestRunsOf, TestCycleError, TEST_TITLE_PREFIX } from "./test-cycles";
import { addField, deleteField, FormEditError } from "./form-builder";
import { saveCycleEmail, CycleEmailValidationError } from "./cycle-emails";
import { setAcceptsRenewals, setCycleDepartments, CyclePublishError } from "./cycles";
import { getApplicantHistory } from "./history";
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

describe("a test run follows the real cycle", () => {
  const fieldKeys = async (cycleId: string) =>
    (await prisma.formField.findMany({ where: { cycleId }, orderBy: [{ order: "asc" }, { key: "asc" }], select: { key: true, label: true } }));

  it("picks up a question added to the real form right away", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    const copy = await createTestCycle(source.id, mgr.id);
    const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: source.id } });

    await addField(section.id, { label: "Why do you want to lead?", type: "LONG_TEXT", required: false });

    expect(await fieldKeys(copy.id)).toEqual(await fieldKeys(source.id));
    expect((await fieldKeys(copy.id)).some((f) => f.label === "Why do you want to lead?")).toBe(true);
  });

  it("drops a question deleted from the real form", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: source.id } });
    const extra = await addField(section.id, { label: "Temporary", type: "SHORT_TEXT", required: false });
    const copy = await createTestCycle(source.id, mgr.id);

    await deleteField(extra.id);

    expect((await fieldKeys(copy.id)).some((f) => f.label === "Temporary")).toBe(false);
  });

  it("picks up an email edit and a settings change", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    const copy = await createTestCycle(source.id, mgr.id);

    await saveCycleEmail(source.id, "recruitment.rejection", { subject: "Thanks for applying", body: "<p>Not this time</p>" }, mgr.id);
    await setAcceptsRenewals(source.id, false, mgr.id);
    await setCycleDepartments(source.id, ["SRHD", "MDIC"], mgr.id);

    const email = await prisma.recruitmentCycleEmail.findUnique({ where: { cycleId_key: { cycleId: copy.id, key: "recruitment.rejection" } } });
    expect(email?.subject).toBe("Thanks for applying");
    const after = await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: copy.id } });
    expect(after.acceptsRenewals).toBe(false);
    expect(after.departments).toEqual(["SRHD", "MDIC"]);
    expect(after.testSyncedAt).not.toBeNull();
  });

  it("keeps its own applicants, status and scoring when it updates", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    const copy = await createTestCycle(source.id, mgr.id);
    await prisma.recruitmentCycle.update({ where: { id: copy.id }, data: { status: "OPEN", scoresPerApplication: 5 } });
    await applyTo(copy.id, "fake@yale.edu");

    await syncTestRunsOf(source.id);

    const after = await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: copy.id } });
    expect(after.status).toBe("OPEN");
    expect(after.scoresPerApplication).toBe(5);
    expect(await prisma.application.count({ where: { cycleId: copy.id } })).toBe(1);
  });

  it("does not copy the real scorer pool", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    await prisma.cycleScorer.create({ data: { cycleId: source.id, personId: mgr.id } });
    const copy = await createTestCycle(source.id, mgr.id);
    expect(await prisma.cycleScorer.count({ where: { cycleId: copy.id } })).toBe(0);
  });

  it("refuses edits made on the test run itself, so it can never drift", async () => {
    const mgr = await manager();
    const copy = await createTestCycle((await realCycle(mgr.id)).id, mgr.id);
    const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: copy.id } });

    await expect(addField(section.id, { label: "Sneaky", type: "SHORT_TEXT", required: false })).rejects.toBeInstanceOf(FormEditError);
    await expect(saveCycleEmail(copy.id, "recruitment.rejection", { subject: "x", body: "<p>x</p>" }, mgr.id))
      .rejects.toBeInstanceOf(CycleEmailValidationError);
    await expect(setAcceptsRenewals(copy.id, false, mgr.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("can be brought up to date by hand", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    const copy = await createTestCycle(source.id, mgr.id);
    // Simulate a sync that never landed: change the real form behind the
    // service's back, then ask for the update.
    const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: source.id } });
    await prisma.formField.create({ data: { sectionId: section.id, cycleId: source.id, key: "late_add", label: "Late add", type: "SHORT_TEXT", required: false, order: 99 } });

    await resyncTestCycle(copy.id, mgr.id);

    expect((await fieldKeys(copy.id)).some((f) => f.key === "late_add")).toBe(true);
  });

  it("keeps its last version when the real cycle is gone", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    const copy = await createTestCycle(source.id, mgr.id);
    const before = await fieldKeys(copy.id);
    await prisma.recruitmentCycle.delete({ where: { id: source.id } });

    await syncTestRunsOf(source.id);
    await expect(resyncTestCycle(copy.id, mgr.id)).rejects.toBeInstanceOf(TestCycleError);
    expect(await fieldKeys(copy.id)).toEqual(before);
  });
});

describe("test applicants stay out of real records", () => {
  it("leaves a test-run application out of the person's applicant history", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    const copy = await createTestCycle(source.id, mgr.id);
    for (const cycleId of [source.id, copy.id]) {
      const app = await applyTo(cycleId, "staff@yale.edu");
      await prisma.application.update({ where: { id: app.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });
    }

    const history = await getApplicantHistory({ viewerId: null, emails: ["staff@yale.edu"] });
    expect(history.applicationCount).toBe(1);
    expect(history.entries.map((e) => e.cycleLabel)).toEqual(["Spring Director 2027"]);
  });
});
