import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { SAMPLE_EMAIL_DOMAIN } from "@/platform/email/address";
import { createCycle } from "./cycles";
import { createTestCycle } from "./test-cycles";
import { addSampleApplicants, setTestPreviewEmail, SAMPLE_APPLICANT_COUNT, SampleApplicantsError } from "./sample-applicants";

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

describe("sending sample applicants' emails to a real inbox", () => {
  it("delivers every confirmation to the inbox the team typed in, marked with who it was for", async () => {
    const mgr = await manager();
    const test = await createTestCycle((await realCycle(mgr.id)).id, mgr.id);

    await setTestPreviewEmail(test.id, "  aiden.hall@yale.edu ", mgr.id);
    await addSampleApplicants(test.id, mgr.id);

    const rows = await prisma.emailLog.findMany({ where: { template: "recruitment.application_received" } });
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.toEmail === "aiden.hall@yale.edu" && r.status === "QUEUED")).toBe(true);
    expect(rows.every((r) => r.subject.startsWith("[TEST] "))).toBe(true);
    expect(rows.some((r) => r.html.includes("Test run preview") && r.html.includes("Beyoncé Knowles"))).toBe(true);
    // Each one names a different sample applicant.
    const named = rows.map((r) => /<strong>([^<]+)<\/strong>/.exec(r.html)?.[1]);
    expect(new Set(named).size).toBe(20);
  });

  it("sends later emails to the inbox too, and stops when it is cleared", async () => {
    const mgr = await manager();
    const test = await createTestCycle((await realCycle(mgr.id)).id, mgr.id);
    await addSampleApplicants(test.id, mgr.id);
    const sample = await prisma.applicant.findFirstOrThrow({ where: { cycleId: test.id } });
    const { queueEmail } = await import("@/platform/email/send");

    await setTestPreviewEmail(test.id, "aiden.hall@yale.edu", mgr.id);
    const sent = await queueEmail(prisma, { to: sample.email, subject: "[TEST] Interview", html: "<p>x</p>", template: "recruitment.interview_invite" });
    expect(sent.toEmail).toBe("aiden.hall@yale.edu");

    await setTestPreviewEmail(test.id, "", mgr.id);
    const kept = await queueEmail(prisma, { to: sample.email, subject: "[TEST] Interview", html: "<p>x</p>", template: "recruitment.interview_invite" });
    expect(kept.toEmail).toBe(sample.email);
    expect(kept.status).toBe("SKIPPED");
  });

  it("gives the same famous name a different address in each test run", async () => {
    const mgr = await manager();
    const source = await realCycle(mgr.id);
    const a = await createTestCycle(source.id, mgr.id);
    const b = await createTestCycle(source.id, mgr.id);
    await setTestPreviewEmail(a.id, "a@yale.edu", mgr.id);
    await setTestPreviewEmail(b.id, "b@yale.edu", mgr.id);
    await addSampleApplicants(a.id, mgr.id);
    await addSampleApplicants(b.id, mgr.id);

    const inA = await prisma.applicant.findFirstOrThrow({ where: { cycleId: a.id, lastName: "Knowles" } });
    const inB = await prisma.applicant.findFirstOrThrow({ where: { cycleId: b.id, lastName: "Knowles" } });
    expect(inA.emailLower).not.toBe(inB.emailLower);
    expect(await prisma.emailLog.count({ where: { toEmail: "a@yale.edu" } })).toBe(20);
    expect(await prisma.emailLog.count({ where: { toEmail: "b@yale.edu" } })).toBe(20);
  });

  it("refuses an address that is not a full email, and a real cycle", async () => {
    const mgr = await manager();
    const real = await realCycle(mgr.id);
    const test = await createTestCycle(real.id, mgr.id);
    await expect(setTestPreviewEmail(test.id, "aiden", mgr.id)).rejects.toBeInstanceOf(SampleApplicantsError);
    await expect(setTestPreviewEmail(real.id, "aiden.hall@yale.edu", mgr.id)).rejects.toBeInstanceOf(SampleApplicantsError);
    expect((await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: real.id } })).testPreviewEmail).toBeNull();
  });

  it("is not copied from the real cycle when the test run updates", async () => {
    const mgr = await manager();
    const real = await realCycle(mgr.id);
    const test = await createTestCycle(real.id, mgr.id);
    await setTestPreviewEmail(test.id, "aiden.hall@yale.edu", mgr.id);
    const { resyncTestCycle } = await import("./test-cycles");
    await resyncTestCycle(test.id, mgr.id);
    expect((await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: test.id } })).testPreviewEmail).toBe("aiden.hall@yale.edu");
  });
});
