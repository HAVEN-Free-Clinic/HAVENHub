import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { config } from "@/platform/config";
import { RecruitmentAuthError } from "./review";
import {
  createOrResendContract, getContractByToken, submitContract, listOnboarding,
  ContractError, ContractValidationError, type ContractSubmission,
} from "./onboarding";

/** submitContract streams HIPAA files to UPLOAD_DIR/onboarding/<contractId>/.
 *  resetDb only truncates the database, so remove the on-disk files this suite
 *  writes; otherwise the leftover directory leaks into other suites (e.g. the
 *  certificates import dry-run test asserts UPLOAD_DIR is empty). */
async function cleanOnboardingUploads() {
  await fs.rm(path.join(config.UPLOAD_DIR, "onboarding"), { recursive: true, force: true });
}

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const plain = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu", emailLower: "ada@yale.edu", netId: "al99" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD"] } });
  const acceptance = await prisma.acceptance.create({ data: { applicationId: application.id, departmentCode: "SRHD", approvedById: srr.id } });
  return { srr, plain, cycle, acceptance };
}

/** One application accepted into TWO departments -- the conflict SRR must
 *  resolve on the Decisions page before onboarding. */
async function seedConflicted() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  await prisma.department.create({ data: { code: "MDIC", name: "MDIC" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["SRHD", "MDIC"], createdById: srr.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu", emailLower: "ada@yale.edu", netId: "al99" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD", "MDIC"] } });
  const accSrhd = await prisma.acceptance.create({ data: { applicationId: application.id, departmentCode: "SRHD", approvedById: srr.id } });
  const accMdic = await prisma.acceptance.create({ data: { applicationId: application.id, departmentCode: "MDIC", approvedById: srr.id } });
  return { srr, cycle, application, accSrhd, accMdic };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); await cleanOnboardingUploads(); });

it("creates a PENDING contract with a token and queues an onboarding email; resend does not duplicate", async () => {
  const { srr, acceptance } = await seed();
  const c1 = await createOrResendContract(acceptance.id, srr.id, "http://test");
  expect(c1.status).toBe("PENDING");
  expect(c1.token).toBeTruthy();
  expect(await prisma.emailLog.count()).toBe(1);
  const c2 = await createOrResendContract(acceptance.id, srr.id, "http://test");
  expect(c2.id).toBe(c1.id);
  expect(await prisma.onboardingContract.count()).toBe(1);
  expect(await prisma.emailLog.count()).toBe(2);
});

it("requires review_all to send", async () => {
  const { plain, acceptance } = await seed();
  await expect(createOrResendContract(acceptance.id, plain.id, "http://test")).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("refuses to send an onboarding link for a conflicted (multi-department) acceptance", async () => {
  const { srr, accSrhd } = await seedConflicted();
  await expect(createOrResendContract(accSrhd.id, srr.id, "http://test")).rejects.toBeInstanceOf(ContractError);
  expect(await prisma.onboardingContract.count()).toBe(0);
  expect(await prisma.emailLog.count()).toBe(0);
});

it("refuses to send an onboarding link unless the cycle is open or closed", async () => {
  const { srr, cycle, acceptance } = await seed();
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "DRAFT" } });
  await expect(createOrResendContract(acceptance.id, srr.id, "http://test")).rejects.toBeInstanceOf(ContractError);
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "ARCHIVED" } });
  await expect(createOrResendContract(acceptance.id, srr.id, "http://test")).rejects.toBeInstanceOf(ContractError);
  expect(await prisma.onboardingContract.count()).toBe(0);
});

it("getContractByToken returns the contract", async () => {
  const { srr, acceptance } = await seed();
  const c = await createOrResendContract(acceptance.id, srr.id, "http://test");
  expect((await getContractByToken(c.token))?.id).toBe(c.id);
});

it("submitContract validates signatures + hipaa and stores SUBMITTED", async () => {
  const { srr, acceptance } = await seed();
  const c = await createOrResendContract(acceptance.id, srr.id, "http://test");
  await expect(submitContract(c.token, {
    firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu",
    agreementSignature: "", professionalismSignature: "Ada", trainingSignature: "Ada", initials: "AL",
    epicNeeded: false, hasEpic: false, worksWithYnhh: false,
    hipaaCompletedAt: "2026-01-01", hipaaFile: { fileName: "c.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") },
  })).rejects.toBeInstanceOf(ContractValidationError);

  const ok = await submitContract(c.token, {
    firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu", netId: "al99", phone: "203",
    agreementSignature: "Ada", professionalismSignature: "Ada", trainingSignature: "Ada", initials: "AL",
    epicNeeded: true, hasEpic: false, worksWithYnhh: false,
    hipaaCompletedAt: "2026-01-01", hipaaFile: { fileName: "c.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") },
  });
  expect(ok.status).toBe("SUBMITTED");
  expect(ok.hipaaStoredName).toBeTruthy();
  expect(ok.epicNeeded).toBe(true);

  await expect(submitContract(c.token, {
    firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu",
    agreementSignature: "Ada", professionalismSignature: "Ada", trainingSignature: "Ada", initials: "AL",
    epicNeeded: false, hasEpic: false, worksWithYnhh: false,
    hipaaCompletedAt: "2026-01-01", hipaaFile: { fileName: "c.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") },
  })).rejects.toBeInstanceOf(ContractError);
});

it("listOnboarding returns acceptances with contract status", async () => {
  const { srr, cycle, acceptance } = await seed();
  await createOrResendContract(acceptance.id, srr.id, "http://test");
  const rows = await listOnboarding(cycle.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].contract?.status).toBe("PENDING");
  expect(rows[0].conflicted).toBe(false);
});

it("listOnboarding flags rows whose application was accepted by more than one department", async () => {
  const { cycle, accSrhd, accMdic } = await seedConflicted();
  const rows = await listOnboarding(cycle.id);
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.id).sort()).toEqual([accSrhd.id, accMdic.id].sort());
  expect(rows.every((r) => r.conflicted)).toBe(true);
});

it("submitContract stores spanishSelfReported and licensedRN", async () => {
  const { srr, acceptance } = await seed();
  const c = await createOrResendContract(acceptance.id, srr.id, "http://test");
  const ok = await submitContract(c.token, {
    firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu", netId: "al99", phone: "203",
    agreementSignature: "Ada", professionalismSignature: "Ada", trainingSignature: "Ada", initials: "AL",
    epicNeeded: false, hasEpic: false, worksWithYnhh: false,
    spanishSelfReported: true, licensedRN: true,
    hipaaCompletedAt: "2026-01-01", hipaaFile: { fileName: "c.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") },
  });
  expect(ok.spanishSelfReported).toBe(true);
  expect(ok.licensedRN).toBe(true);
});

describe("submitContract HIPAA date validation", () => {
  async function pendingContract() {
    const { srr, acceptance } = await seed();
    const c = await createOrResendContract(acceptance.id, srr.id, "http://test");
    await prisma.onboardingContract.update({
      where: { id: c.id },
      data: { hipaaStoredName: "pre-seeded.pdf" },
    });
    return { token: c.token };
  }

  const base: Omit<ContractSubmission, "hipaaCompletedAt" | "hipaaFile"> = {
    firstName: "A", lastName: "B", email: "a@b.com",
    agreementSignature: "A B", professionalismSignature: "A B",
    trainingSignature: "A B", initials: "AB",
    epicNeeded: false, hasEpic: false, worksWithYnhh: false,
  };

  it("rejects a future completion date", async () => {
    const { token } = await pendingContract();
    const nextYear = new Date().getUTCFullYear() + 1;
    await expect(
      submitContract(token, { ...base, hipaaCompletedAt: `${nextYear}-01-01` }),
    ).rejects.toMatchObject({ fieldErrors: { hipaaCompletedAt: expect.any(String) } });
  });

  it("rejects a date older than 5 years", async () => {
    const { token } = await pendingContract();
    const old = new Date().getUTCFullYear() - 6;
    await expect(
      submitContract(token, { ...base, hipaaCompletedAt: `${old}-01-01` }),
    ).rejects.toBeInstanceOf(ContractValidationError);
  });

  it("rejects a malformed date", async () => {
    const { token } = await pendingContract();
    await expect(
      submitContract(token, { ...base, hipaaCompletedAt: "06/01/2025" }),
    ).rejects.toBeInstanceOf(ContractValidationError);
  });

  it("stores a valid date normalized to noon UTC", async () => {
    const { token } = await pendingContract();
    const yyyy = new Date().getUTCFullYear() - 1;
    const updated = await submitContract(token, { ...base, hipaaCompletedAt: `${yyyy}-06-01` });
    expect(updated.hipaaCompletedAt?.toISOString()).toBe(`${yyyy}-06-01T12:00:00.000Z`);
  });
});

it("uses the cycle's onboarding email override when present", async () => {
  const { srr, cycle, acceptance } = await seed();
  const cycleId = cycle.id;
  const acceptanceId = acceptance.id;
  const actorId = srr.id;
  await prisma.recruitmentCycleEmail.create({
    data: { cycleId, key: "recruitment.onboarding", subject: "Finish {{ cycleTitle }}", body: '<p>Go to <a href="{{ contractUrl }}">link</a></p>' },
  });
  await createOrResendContract(acceptanceId, actorId, "https://hub.test");
  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.onboarding" } });
  expect(mail.subject).toContain("Finish");
  expect(mail.html).toContain("Go to");
  expect(mail.html).toContain("<!DOCTYPE html>");
});
