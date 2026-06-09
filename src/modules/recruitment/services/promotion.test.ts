import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { promoteContracts } from "./promotion";

async function seedSubmitted(opts: { netId?: string; email?: string; epicNeeded?: boolean; existingEpicId?: string } = {}) {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const srhd = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace", email: opts.email ?? "ada@yale.edu", emailLower: (opts.email ?? "ada@yale.edu").toLowerCase(), netId: opts.netId ?? "al99" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD"] } });
  const acceptance = await prisma.acceptance.create({ data: { applicationId: application.id, departmentCode: "SRHD", approvedById: srr.id } });
  const contract = await prisma.onboardingContract.create({ data: {
    acceptanceId: acceptance.id, token: `t-${Math.random()}`, status: "SUBMITTED",
    firstName: "Ada", lastName: "Lovelace", email: opts.email ?? "ada@yale.edu", netId: opts.netId ?? "al99",
    agreementSignature: "Ada", professionalismSignature: "Ada", trainingSignature: "Ada", initials: "AL",
    epicNeeded: opts.epicNeeded ?? false, hasEpic: !!opts.existingEpicId, existingEpicId: opts.existingEpicId,
    hipaaStoredName: "hipaa-x.pdf", hipaaFileName: "c.pdf", hipaaMimeType: "application/pdf", hipaaSize: 10, hipaaCompletedAt: new Date("2026-01-01"),
    submittedAt: new Date(),
  } });
  return { term, srhd, srr, cycle, contract };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("creates a new ACTIVE person + membership + hipaa cert + epic request when epicNeeded", async () => {
  const { term, srhd, srr, contract } = await seedSubmitted({ epicNeeded: true });
  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 1, reactivated: 0, skipped: 0 });
  const person = await prisma.person.findFirstOrThrow({ where: { netId: "al99" } });
  expect(person.status).toBe("ACTIVE");
  expect(await prisma.termMembership.count({ where: { personId: person.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER" } })).toBe(1);
  expect(await prisma.hipaaCertificate.count({ where: { personId: person.id } })).toBe(1);
  expect(await prisma.epicRequest.count({ where: { personId: person.id, kind: "NEW" } })).toBe(1);
  const after = await prisma.onboardingContract.findUniqueOrThrow({ where: { id: contract.id } });
  expect(after.status).toBe("PROMOTED");
  expect(after.promotedPersonId).toBe(person.id);
});

it("reactivates a returning person matched by netId without duplicating", async () => {
  const existing = await prisma.person.create({ data: { name: "Ada Lovelace", netId: "al99", status: "OFFBOARDED" } });
  const { srr, contract } = await seedSubmitted({ netId: "al99", epicNeeded: false });
  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 0, reactivated: 1, skipped: 0 });
  expect(await prisma.person.count({ where: { netId: "al99" } })).toBe(1);
  expect((await prisma.person.findUniqueOrThrow({ where: { id: existing.id } })).status).toBe("ACTIVE");
});

it("sets epicId from existingEpicId and creates no epic request", async () => {
  const { srr, contract } = await seedSubmitted({ epicNeeded: true, existingEpicId: "EPIC777" });
  await promoteContracts([contract.id], srr.id);
  const person = await prisma.person.findFirstOrThrow({ where: { netId: "al99" } });
  expect(person.epicId).toBe("EPIC777");
  expect(await prisma.epicRequest.count({ where: { personId: person.id } })).toBe(0);
});

it("skips a non-SUBMITTED contract (idempotent re-run)", async () => {
  const { srr, contract } = await seedSubmitted({ epicNeeded: false });
  await promoteContracts([contract.id], srr.id);
  const res2 = await promoteContracts([contract.id], srr.id);
  expect(res2).toEqual({ created: 0, reactivated: 0, skipped: 1 });
});

it("requires review_all", async () => {
  const { contract } = await seedSubmitted();
  const plain = await prisma.person.create({ data: { name: "No", status: "ACTIVE" } });
  await expect(promoteContracts([contract.id], plain.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("reactivates a returning person matched by email when the contract has no netId", async () => {
  const existing = await prisma.person.create({ data: { name: "Mary Match", contactEmail: "mary@yale.edu", status: "OFFBOARDED" } });
  const { srr, contract } = await seedSubmitted({ email: "mary@yale.edu" });
  // clear the contract netId so matching falls through to contactEmail
  await prisma.onboardingContract.update({ where: { id: contract.id }, data: { netId: null } });
  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 0, reactivated: 1, skipped: 0 });
  expect(await prisma.person.count({ where: { contactEmail: "mary@yale.edu" } })).toBe(1);
  expect((await prisma.person.findUniqueOrThrow({ where: { id: existing.id } })).status).toBe("ACTIVE");
});
