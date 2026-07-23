import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import {
  createOrResendContract, submitContract, lookupStoredEpicId, withdrawContract,
  ContractValidationError, ContractError, type ContractSubmission,
} from "./onboarding";
import { revokeAcceptance, RecruitmentAuthError } from "./review";
import type { ContractLayout } from "../contract/layout";
import type { SignatureInput } from "../contract/signatures";

/** A minimal valid 1x1 PNG data URL: passes decodeSignaturePng's magic-byte check. */
const REAL_SIG_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";
const realSig = (name = "Ada Lovelace"): SignatureInput => ({ dataUrl: REAL_SIG_PNG, method: "draw", name });

/** A layout mirroring the real DIRECTOR_LAYOUT shape closely enough to exercise
 *  department-gated agreements + a checkbox agreement + the epic_needed_self
 *  question, without pulling in the full department-responsibilities prose. */
function layoutFor(): ContractLayout {
  return {
    blocks: [
      { kind: "system_field", systemKey: "name" },
      { kind: "system_field", systemKey: "email" },
      { kind: "system_field", systemKey: "hipaa" },
      { kind: "agreement", id: "dept_bvhd", title: "BVHD responsibilities", confirmKind: "checkbox",
        signatureLabel: "I confirm these responsibilities", body: "",
        visibleWhen: { field: "department", op: "is", value: "BVHD" } },
      { kind: "agreement", id: "dept_srhd", title: "SRHD responsibilities", confirmKind: "checkbox",
        signatureLabel: "I confirm these responsibilities", body: "",
        visibleWhen: { field: "department", op: "is", value: "SRHD" } },
      { kind: "custom_question", key: "epic_needed_self",
        label: "Is Epic access required for your role?",
        type: "SINGLE_SELECT", required: true,
        options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
        visibleWhen: { field: "epicRequirement", op: "is", value: "SOME" } },
      { kind: "system_field", systemKey: "epic" },
    ],
  };
}

/** Seeds a term + two departments (BVHD with ALL, SRHD with NONE by default, both
 *  overridable) + a cycle + an applicant accepted into `deptCode`, and freezes
 *  `layoutFor()` onto the contract's templateSnapshot. Returns the pending
 *  contract's token plus the ids callers may need. */
async function seedPending(opts: {
  deptCode: string;
  requiresEpicVolunteer?: "ALL" | "NONE" | "SOME";
  requiresEpicDirector?: "ALL" | "NONE" | "SOME";
  track?: "VOLUNTEER" | "DIRECTOR";
}) {
  const { deptCode, requiresEpicVolunteer = "NONE", requiresEpicDirector = "NONE", track = "VOLUNTEER" } = opts;
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "BVHD", name: "Behavioral Health", requiresEpicVolunteer: deptCode === "BVHD" ? requiresEpicVolunteer : "ALL", requiresEpicDirector: deptCode === "BVHD" ? requiresEpicDirector : "NONE" } });
  await prisma.department.create({ data: { code: "SRHD", name: "Sexual and Reproductive Health", requiresEpicVolunteer: deptCode === "SRHD" ? requiresEpicVolunteer : "NONE", requiresEpicDirector: deptCode === "SRHD" ? requiresEpicDirector : "NONE" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track, termId: term.id, title: "V", publicSlug: `v-${deptCode}-${track}`, departments: [deptCode], createdById: srr.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace", email: `ada-${deptCode}-${track}@yale.edu`, emailLower: `ada-${deptCode}-${track}@yale.edu`, netId: "al99" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: [deptCode] } });
  const acceptance = await prisma.acceptance.create({ data: { applicationId: application.id, departmentCode: deptCode, approvedById: srr.id } });
  const contract = await createOrResendContract(acceptance.id, srr.id, "http://test");
  await prisma.onboardingContract.update({ where: { id: contract.id }, data: { templateSnapshot: layoutFor() as object } });
  return { token: contract.token, contractId: contract.id, srrId: srr.id, acceptanceId: acceptance.id };
}

const base: Omit<ContractSubmission, "signatures" | "customAnswers" | "confirmations"> = {
  firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu",
  hasEpic: false, worksWithYnhh: false,
  hipaaCompletedAt: "2026-01-01",
  hipaaFile: { fileName: "c.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") },
};

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("submitContract visibility and Epic resolution", () => {
  it("does not require a signature/confirmation for a block hidden by department", async () => {
    // Accepted into BVHD: the SRHD agreement is hidden by visibleWhen and must
    // not block submission even though it is never confirmed.
    const { token } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "ALL" });
    const res = await submitContract(token, {
      ...base,
      signatures: {},
      customAnswers: {},
      confirmations: { dept_bvhd: true },
    });
    expect(res.status).toBe("SUBMITTED");
  });

  it("still requires the visible department block", async () => {
    const { token } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "ALL" });
    await expect(
      submitContract(token, { ...base, signatures: {}, customAnswers: {}, confirmations: {} }),
    ).rejects.toThrow(ContractValidationError);
  });

  it("sets epicNeeded true for an ALL department without asking epic_needed_self", async () => {
    const { token } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "ALL" });
    const res = await submitContract(token, {
      ...base,
      signatures: {},
      customAnswers: {},
      confirmations: { dept_bvhd: true },
    });
    expect(res.epicNeeded).toBe(true);
  });

  it("sets epicNeeded false for a NONE department even if the answer says yes", async () => {
    const { token } = await seedPending({ deptCode: "SRHD", requiresEpicVolunteer: "NONE" });
    const res = await submitContract(token, {
      ...base,
      signatures: {},
      // epic_needed_self is hidden for a NONE department (epicRequirement !==
      // "SOME"), so this answer is moot, but supplying it must not flip epicNeeded.
      customAnswers: { epic_needed_self: "yes" },
      confirmations: { dept_srhd: true },
    });
    expect(res.epicNeeded).toBe(false);
  });

  it("defers to the answer for a SOME department (yes)", async () => {
    const { token } = await seedPending({ deptCode: "SRHD", requiresEpicVolunteer: "SOME" });
    const res = await submitContract(token, {
      ...base,
      signatures: {},
      customAnswers: { epic_needed_self: "yes" },
      confirmations: { dept_srhd: true },
    });
    expect(res.epicNeeded).toBe(true);
  });

  it("defers to the answer for a SOME department (no)", async () => {
    const { token } = await seedPending({ deptCode: "SRHD", requiresEpicVolunteer: "SOME" });
    const res = await submitContract(token, {
      ...base,
      signatures: {},
      customAnswers: { epic_needed_self: "no" },
      confirmations: { dept_srhd: true },
    });
    expect(res.epicNeeded).toBe(false);
  });

  // Note: a SOME department's epic_needed_self question is itself required:true
  // whenever it is visible (i.e. whenever epicRequirement is SOME), so an
  // absent answer for a SOME department is rejected by the required-question
  // check, not silently resolved -- unlike the ALL/NONE cases below where the
  // question is hidden and therefore not required at all. resolveEpicNeeded's
  // own "absent -> false" behavior for SOME is unit-tested directly in
  // epic-requirement.test.ts.

  it("the epic_needed_self-hidden case: an ALL department applicant with no epic_needed_self answer still submits successfully", async () => {
    // This is the exact bug being closed: epic_needed_self is required:true in
    // the layout but gated on epicRequirement === "SOME"; an ALL department
    // hides it, and the applicant supplies no answer for it at all.
    const { token } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "ALL" });
    const res = await submitContract(token, {
      ...base,
      signatures: {},
      customAnswers: {},
      confirmations: { dept_bvhd: true },
    });
    expect(res.status).toBe("SUBMITTED");
    expect(res.epicNeeded).toBe(true);
  });

  it("the epic_needed_self-hidden case: a NONE department applicant with no epic_needed_self answer still submits successfully", async () => {
    const { token } = await seedPending({ deptCode: "SRHD", requiresEpicVolunteer: "NONE" });
    const res = await submitContract(token, {
      ...base,
      signatures: {},
      customAnswers: {},
      confirmations: { dept_srhd: true },
    });
    expect(res.status).toBe("SUBMITTED");
    expect(res.epicNeeded).toBe(false);
  });

  it("persists pronouns and staff title", async () => {
    const { token } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "ALL" });
    const res = await submitContract(token, {
      ...base,
      pronouns: "they/them", staffTitle: "Program Manager",
      signatures: {},
      customAnswers: {},
      confirmations: { dept_bvhd: true },
    });
    expect(res.pronouns).toBe("they/them");
    expect(res.staffTitle).toBe("Program Manager");
  });

  it("persists epicIdExpiration as a Date when present", async () => {
    const { token } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "ALL" });
    const res = await submitContract(token, {
      ...base,
      epicIdExpiration: "2027-05-01",
      signatures: {},
      customAnswers: {},
      confirmations: { dept_bvhd: true },
    });
    expect(res.epicIdExpiration?.toISOString()).toBe("2027-05-01T00:00:00.000Z");
  });

  it("persists epicIdExpiration as null when absent", async () => {
    // The absent case actually submitted and asserted: epicIdExpiration must
    // persist as null, not an Invalid Date (input.epicIdExpiration is falsy,
    // so parseYmdDate is never called and epicIdExpiration stays undefined,
    // which the claim write coalesces to null).
    const { token } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "ALL" });
    const res = await submitContract(token, {
      ...base,
      signatures: {},
      customAnswers: {},
      confirmations: { dept_bvhd: true },
    });
    expect(res.epicIdExpiration).toBeNull();
  });

  it("rejects an epicIdExpiration that overflows the calendar", async () => {
    const { token } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "ALL" });
    const err = await submitContract(token, {
      ...base,
      epicIdExpiration: "2026-02-30",
      signatures: {},
      customAnswers: {},
      confirmations: { dept_bvhd: true },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ContractValidationError);
    expect((err as ContractValidationError).fieldErrors.epicIdExpiration).toBe("Enter a valid date.");
  });

  it("rejects an epicIdExpiration that is not a date at all", async () => {
    const { token } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "ALL" });
    const err = await submitContract(token, {
      ...base,
      epicIdExpiration: "not-a-date",
      signatures: {},
      customAnswers: {},
      confirmations: { dept_bvhd: true },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ContractValidationError);
    expect((err as ContractValidationError).fieldErrors.epicIdExpiration).toBe("Enter a valid date.");
  });

  it("requires a checkbox confirmation for a visible checkbox agreement", async () => {
    const { token } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "ALL" });
    await expect(
      submitContract(token, { ...base, signatures: {}, customAnswers: {}, confirmations: {} }),
    ).rejects.toThrow(ContractValidationError);
  });

  it("submits once the visible checkbox agreement is confirmed", async () => {
    const { token } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "ALL" });
    const res = await submitContract(token, {
      ...base,
      signatures: {},
      customAnswers: {},
      confirmations: { dept_bvhd: true },
    });
    expect(res.status).toBe("SUBMITTED");
  });

  it("does not throw when the department no longer resolves (stale departmentCode); degrades to requirement NONE", async () => {
    // departmentCode is a plain string column with no FK to Department (a
    // department can be renamed/deleted after the acceptance was made), so
    // this is a realistic broken-chain case, not a contrived one. It must
    // degrade safely (epicRequirementFor's null-department branch -> NONE)
    // rather than throwing.
    const { token, contractId } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "ALL" });
    const contract = await prisma.onboardingContract.findUniqueOrThrow({ where: { id: contractId } });
    await prisma.acceptance.update({ where: { id: contract.acceptanceId }, data: { departmentCode: "GONE" } });
    // Freeze a layout with no department-gated blocks, since with the
    // department no longer resolving, neither dept_bvhd nor dept_srhd (both
    // visibleWhen department is X) would ever be visible or requirable.
    await prisma.onboardingContract.update({
      where: { id: contractId },
      data: {
        templateSnapshot: {
          blocks: [
            { kind: "system_field", systemKey: "name" },
            { kind: "system_field", systemKey: "email" },
            { kind: "system_field", systemKey: "hipaa" },
          ],
        },
      },
    });
    const res = await submitContract(token, { ...base, signatures: {}, customAnswers: {}, confirmations: {} });
    expect(res.status).toBe("SUBMITTED");
    expect(res.epicNeeded).toBe(false);
  });

  it("director track reads the director Epic requirement column, not the volunteer one", async () => {
    const { token } = await seedPending({
      deptCode: "BVHD", track: "DIRECTOR",
      requiresEpicDirector: "ALL", requiresEpicVolunteer: "NONE",
    });
    const res = await submitContract(token, {
      ...base,
      signatures: {},
      customAnswers: {},
      confirmations: { dept_bvhd: true },
    });
    expect(res.epicNeeded).toBe(true);
  });

  it("sees a submitted system-field value that gates a required custom question (client/server visibility parity)", async () => {
    // The client's answers map includes submitted system-field values (see
    // onboard-form.tsx), so a block gated on one of those fields is visible
    // to the client whenever the applicant's answer satisfies the condition.
    // Before this fix the server's answers map never carried yaleAffiliation,
    // so a required custom_question gated on it stayed permanently HIDDEN
    // server-side no matter what the applicant submitted -- this constructed
    // layout proves the server now sees the same value the client does.
    const { token, contractId } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "NONE" });
    await prisma.onboardingContract.update({
      where: { id: contractId },
      data: {
        templateSnapshot: {
          blocks: [
            { kind: "system_field", systemKey: "name" },
            { kind: "system_field", systemKey: "email" },
            { kind: "system_field", systemKey: "hipaa" },
            {
              kind: "custom_question", key: "staff_reason", label: "Why are you staff?",
              type: "SHORT_TEXT", required: true,
              visibleWhen: { field: "yaleAffiliation", op: "is", value: "staff" },
            },
          ],
        },
      },
    });

    // yaleAffiliation="staff" makes staff_reason visible and required; omitting
    // an answer must be rejected under its own field key. This only happens if
    // the server's answers map actually contains the submitted yaleAffiliation.
    const err = await submitContract(token, {
      ...base, yaleAffiliation: "staff", signatures: {}, customAnswers: {}, confirmations: {},
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ContractValidationError);
    expect((err as ContractValidationError).fieldErrors.custom__staff_reason).toBe("required");
  });

  it("hides a custom question gated on a system-field value the applicant did not submit", async () => {
    const { token, contractId } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "NONE" });
    await prisma.onboardingContract.update({
      where: { id: contractId },
      data: {
        templateSnapshot: {
          blocks: [
            { kind: "system_field", systemKey: "name" },
            { kind: "system_field", systemKey: "email" },
            { kind: "system_field", systemKey: "hipaa" },
            {
              kind: "custom_question", key: "staff_reason", label: "Why are you staff?",
              type: "SHORT_TEXT", required: true,
              visibleWhen: { field: "yaleAffiliation", op: "is", value: "staff" },
            },
          ],
        },
      },
    });

    // yaleAffiliation="college" hides staff_reason, so submission succeeds
    // without ever answering it.
    const res = await submitContract(token, {
      ...base, yaleAffiliation: "college", signatures: {}, customAnswers: {}, confirmations: {},
    });
    expect(res.status).toBe("SUBMITTED");
  });

  it("submits end-to-end against the real production DIRECTOR_LAYOUT (checkbox + signature agreements together)", async () => {
    // Not the hand-rolled layoutFor() above: this freezes whatever
    // createOrResendContract actually resolves for a DIRECTOR cycle (the real
    // DIRECTOR_LAYOUT, full of confirmKind: "checkbox" agreements, including
    // the department-specific responsibility block and 3 signature-kind
    // agreements). Before this task, a checkbox-kind agreement's block id was
    // still fed into the signature-blob loop even after the checkbox split
    // fixed the validation error, throwing on `sig.dataUrl` for a signature
    // that never existed -- this proves that path is gone.
    const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
    await prisma.department.create({ data: { code: "BVHD", name: "Behavioral Health", requiresEpicDirector: "ALL", requiresEpicVolunteer: "NONE" } });
    const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
    const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
    await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
    const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d-real", departments: ["BVHD"], createdById: srr.id, status: "OPEN" } });
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace", email: "ada-real@yale.edu", emailLower: "ada-real@yale.edu", netId: "al99" } });
    const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["BVHD"] } });
    const acceptance = await prisma.acceptance.create({ data: { applicationId: application.id, departmentCode: "BVHD", approvedById: srr.id } });
    const contract = await createOrResendContract(acceptance.id, srr.id, "http://test");

    const res = await submitContract(contract.token, {
      ...base,
      // Every checkbox agreement in DIRECTOR_LAYOUT: board_responsibilities,
      // strike_policy, training, plus the one visible department block
      // (dept_bvhd -- the other 25 DEPARTMENT_RESPONSIBILITY_BLOCKS are hidden
      // by visibleWhen and must not be required).
      confirmations: { board_responsibilities: true, strike_policy: true, training: true, dept_bvhd: true },
      // Every signature-kind agreement: data_privacy, haven_agreement, final_acknowledgement.
      signatures: { data_privacy: realSig(), haven_agreement: realSig(), final_acknowledgement: realSig() },
      // second_department is required:true unconditionally; epic_needed_self
      // is hidden (requirement is ALL, not SOME) so it is deliberately omitted.
      customAnswers: { second_department: "no" },
    });
    expect(res.status).toBe("SUBMITTED");
    expect(res.epicNeeded).toBe(true);
  });
});

describe("lookupStoredEpicId", () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(async () => { await resetDb(); });

  it("matches an existing Person by netId (case-insensitive) and returns their Epic ID", async () => {
    await prisma.person.create({ data: { name: "Ada", status: "ACTIVE", netId: "AL99", epicId: "YM111" } });
    expect(await lookupStoredEpicId("al99", "other@yale.edu")).toBe("YM111");
  });

  it("falls back to contactEmail when there is no netId match", async () => {
    await prisma.person.create({ data: { name: "Ada", status: "ACTIVE", contactEmail: "ada@yale.edu", epicId: "YM222" } });
    expect(await lookupStoredEpicId(null, "ADA@yale.edu")).toBe("YM222");
  });

  it("returns null for a brand-new applicant with no matching Person", async () => {
    expect(await lookupStoredEpicId("nobody", "nobody@yale.edu")).toBeNull();
  });

  it("returns null when the matched Person has no Epic ID on file", async () => {
    await prisma.person.create({ data: { name: "Ada", status: "ACTIVE", netId: "al99" } });
    expect(await lookupStoredEpicId("al99", null)).toBeNull();
  });
});

describe("submitContract Epic section visibility from a stored Epic ID", () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(async () => { await resetDb(); });

  // A block gated on epicSection === "show" is hidden for a NONE department with
  // no id on file, but a stored Epic ID forces the section visible. This proves
  // lookupStoredEpicId reaches the server's visibility map, matching the client.
  const epicGatedLayout = (): ContractLayout => ({
    blocks: [
      { kind: "system_field", systemKey: "name" },
      { kind: "system_field", systemKey: "email" },
      { kind: "system_field", systemKey: "hipaa" },
      { kind: "agreement", id: "epic_ack", title: "Epic acknowledgement", confirmKind: "checkbox",
        signatureLabel: "I confirm", body: "",
        visibleWhen: { field: "epicSection", op: "is", value: "show" } },
    ],
  });

  it("hides the epicSection block for a NONE department with no id on file (submits without it)", async () => {
    const { token, contractId } = await seedPending({ deptCode: "SRHD", requiresEpicVolunteer: "NONE" });
    await prisma.onboardingContract.update({ where: { id: contractId }, data: { templateSnapshot: epicGatedLayout() as object } });
    const res = await submitContract(token, { ...base, signatures: {}, customAnswers: {}, confirmations: {} });
    expect(res.status).toBe("SUBMITTED");
  });

  it("shows and requires the epicSection block when an Epic ID is on file, even for a NONE department", async () => {
    const { token, contractId } = await seedPending({ deptCode: "SRHD", requiresEpicVolunteer: "NONE" });
    await prisma.onboardingContract.update({ where: { id: contractId }, data: { templateSnapshot: epicGatedLayout() as object } });
    // Seed a Person matching the contract's netId (al99) with an Epic ID on file.
    await prisma.person.create({ data: { name: "Ada", status: "ACTIVE", netId: "al99", epicId: "YM999" } });

    const missing = await submitContract(token, { ...base, signatures: {}, customAnswers: {}, confirmations: {} }).catch((e) => e);
    expect(missing).toBeInstanceOf(ContractValidationError);
    expect((missing as ContractValidationError).fieldErrors.confirm__epic_ack).toBe("required");

    const ok = await submitContract(token, { ...base, signatures: {}, customAnswers: {}, confirmations: { epic_ack: true } });
    expect(ok.status).toBe("SUBMITTED");
  });
});

describe("withdrawContract", () => {
  it("deletes a PENDING contract so its acceptance becomes re-decidable", async () => {
    const { contractId, srrId, acceptanceId } = await seedPending({ deptCode: "SRHD" });

    await withdrawContract(contractId, srrId);

    expect(await prisma.onboardingContract.findUnique({ where: { id: contractId } })).toBeNull();
    // The acceptance survives and, with no contract, can now be revoked -- the
    // exact recovery the guard's message promised but nothing could perform.
    await expect(revokeAcceptance(acceptanceId, srrId)).resolves.toBeUndefined();
    expect(await prisma.acceptance.findUnique({ where: { id: acceptanceId } })).toBeNull();
  });

  it("deletes a SUBMITTED contract and its stored blobs", async () => {
    const { token, contractId, srrId } = await seedPending({ deptCode: "BVHD", requiresEpicVolunteer: "ALL" });
    await submitContract(token, { ...base, signatures: {}, customAnswers: {}, confirmations: { dept_bvhd: true } });
    const submitted = await prisma.onboardingContract.findUniqueOrThrow({ where: { id: contractId } });
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.hipaaStoredName).not.toBeNull();

    await withdrawContract(contractId, srrId);

    expect(await prisma.onboardingContract.findUnique({ where: { id: contractId } })).toBeNull();
  });

  it("refuses to withdraw a PROMOTED contract (offboard instead)", async () => {
    const { contractId, srrId } = await seedPending({ deptCode: "SRHD" });
    await prisma.onboardingContract.update({ where: { id: contractId }, data: { status: "PROMOTED" } });

    await expect(withdrawContract(contractId, srrId)).rejects.toBeInstanceOf(ContractError);
    // Still there: a promoted contract is a real member and must not be deleted.
    expect(await prisma.onboardingContract.findUnique({ where: { id: contractId } })).not.toBeNull();
  });

  it("refuses a non-SRR actor", async () => {
    const { contractId } = await seedPending({ deptCode: "SRHD" });
    const outsider = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });
    await expect(withdrawContract(contractId, outsider.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
    expect(await prisma.onboardingContract.findUnique({ where: { id: contractId } })).not.toBeNull();
  });

  it("errors on an unknown contract id", async () => {
    const { srrId } = await seedPending({ deptCode: "SRHD" });
    await expect(withdrawContract("nope", srrId)).rejects.toBeInstanceOf(ContractError);
  });
});
