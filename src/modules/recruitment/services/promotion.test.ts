import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { promoteContracts, parseAvailabilityDates } from "./promotion";
import { spanishReviewWhere } from "@/platform/spanish-review";

async function seedSubmitted(opts: { netId?: string; email?: string; epicNeeded?: boolean; existingEpicId?: string; applicantType?: "NEW" | "RENEWAL" | "TRANSFER"; transferFromDepartments?: string[]; availability?: string[] } = {}) {
  const term = await prisma.term.create({ data: {
    code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE",
    // Keep the calendar consistent with the availability the test seeded, so
    // promotion's clinic-date filter is exercised rather than tripped over.
    clinicDates: (opts.availability ?? []).map((d) => new Date(`${d}T12:00:00.000Z`)),
  } });
  const srhd = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace", email: opts.email ?? "ada@yale.edu", emailLower: (opts.email ?? "ada@yale.edu").toLowerCase(), netId: opts.netId ?? "al99" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: opts.availability ? { availability: opts.availability } : {}, applicantType: opts.applicantType ?? "NEW", departmentChoices: ["SRHD"], transferFromDepartments: opts.transferFromDepartments ?? [] } });
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

it("skips a conflicted (multi-department) contract and creates no person or membership", async () => {
  const { srr, cycle, contract } = await seedSubmitted({ epicNeeded: false });
  // Add a second acceptance in another department to the same application,
  // turning it into a conflict the SRR must resolve before promotion.
  const acc = await prisma.acceptance.findFirstOrThrow({ where: { contract: { id: contract.id } } });
  await prisma.department.create({ data: { code: "MDIC", name: "MDIC" } });
  await prisma.acceptance.create({ data: { applicationId: acc.applicationId, departmentCode: "MDIC", approvedById: srr.id } });

  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 0, reactivated: 0, skipped: 1 });
  expect(await prisma.person.count({ where: { netId: "al99" } })).toBe(0);
  expect(await prisma.termMembership.count({ where: { termId: cycle.termId } })).toBe(0);
  expect((await prisma.onboardingContract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe("SUBMITTED");
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

it("maps spanishSelfReported + licensedRN onto the Person, leaves verified false, and enters the queue", async () => {
  const { srr, contract } = await seedSubmitted({ netId: "rn1", email: "rn1@yale.edu" });
  await prisma.onboardingContract.update({
    where: { id: contract.id },
    data: { spanishSelfReported: true, licensedRN: true },
  });

  const res = await promoteContracts([contract.id], srr.id);
  expect(res.created).toBe(1);

  const person = await prisma.person.findFirstOrThrow({ where: { netId: "rn1" } });
  expect(person.spanishSelfReported).toBe(true);
  expect(person.licensedRN).toBe(true);
  expect(person.spanishVerified).toBe(false);

  const queue = await prisma.person.findMany({ where: spanishReviewWhere(), select: { id: true } });
  expect(queue.map((r) => r.id)).toContain(person.id);
});

it("promotes a TRANSFER applicant into the accepted department, not their prior one", async () => {
  const { term, srhd, srr, contract } = await seedSubmitted({ applicantType: "TRANSFER", transferFromDepartments: ["MDIC"] });
  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 1, reactivated: 0, skipped: 0 });
  const person = await prisma.person.findFirstOrThrow({ where: { netId: "al99" } });
  expect(await prisma.termMembership.count({ where: { personId: person.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER" } })).toBe(1);
});

it("reactivates a REMOVED membership for the same term/dept/kind rather than leaving the person off every ACTIVE roster (audit3 M1)", async () => {
  const existing = await prisma.person.create({ data: { name: "Ada Lovelace", netId: "al99", status: "OFFBOARDED" } });
  const { term, srhd, srr, contract } = await seedSubmitted({ netId: "al99", epicNeeded: false });
  // Offboarding flips the membership to REMOVED rather than deleting it; a bare
  // findFirst-then-create would skip the create and leave the stale REMOVED row,
  // so the re-promoted (ACTIVE) person would be absent from every ACTIVE-keyed
  // roster/scheduler/compliance surface.
  const removed = await prisma.termMembership.create({ data: { personId: existing.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER", status: "REMOVED" } });

  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 0, reactivated: 1, skipped: 0 });

  // No duplicate membership; the existing row is flipped back to ACTIVE.
  const memberships = await prisma.termMembership.findMany({ where: { personId: existing.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER" } });
  expect(memberships).toHaveLength(1);
  expect(memberships[0].id).toBe(removed.id);
  expect(memberships[0].status).toBe("ACTIVE");
});

it("leaves an already-ACTIVE membership untouched on re-promotion (audit3 M1)", async () => {
  const existing = await prisma.person.create({ data: { name: "Ada Lovelace", netId: "al99", status: "ACTIVE" } });
  const { term, srhd, srr, contract } = await seedSubmitted({ netId: "al99", epicNeeded: false });
  const active = await prisma.termMembership.create({ data: { personId: existing.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER", status: "ACTIVE" } });

  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 0, reactivated: 1, skipped: 0 });

  const memberships = await prisma.termMembership.findMany({ where: { personId: existing.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER" } });
  expect(memberships).toHaveLength(1);
  expect(memberships[0].id).toBe(active.id);
  expect(memberships[0].status).toBe("ACTIVE");
});

it("carries the application's availability answer into TermMembership.baselineAvailability", async () => {
  const { term, srhd, srr, contract } = await seedSubmitted({ availability: ["2026-05-30", "2026-06-06", "2026-06-13"] });
  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 1, reactivated: 0, skipped: 0 });
  const person = await prisma.person.findFirstOrThrow({ where: { netId: "al99" } });
  const membership = await prisma.termMembership.findFirstOrThrow({
    where: { personId: person.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER" },
  });
  expect(membership.baselineAvailability.map((d) => d.toISOString())).toEqual([
    "2026-05-30T00:00:00.000Z",
    "2026-06-06T00:00:00.000Z",
    "2026-06-13T00:00:00.000Z",
  ]);
});

it("drops availability dates that are not on the term's clinic calendar", async () => {
  // A pre-existing application: 2026-06-13 was offered as a "term Saturday" but
  // is not a clinic date, so it must not reach baselineAvailability.
  const { term, srhd, srr, contract } = await seedSubmitted({ availability: ["2026-06-06", "2026-06-13"] });
  await prisma.term.update({
    where: { id: term.id },
    data: { clinicDates: [new Date("2026-06-06T12:00:00.000Z")] },
  });

  await promoteContracts([contract.id], srr.id);

  const person = await prisma.person.findFirstOrThrow({ where: { netId: "al99" } });
  const membership = await prisma.termMembership.findFirstOrThrow({
    where: { personId: person.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER" },
  });
  expect(membership.baselineAvailability.map((d) => d.toISOString())).toEqual([
    "2026-06-06T00:00:00.000Z",
  ]);
});

it("clears a REMOVED membership's stale baselineAvailability when the reactivating application's availability is entirely off-calendar", async () => {
  // The applicant did answer the availability question, but every date they
  // picked has since fallen off the term's clinic calendar (a stale phantom
  // Saturday from before the clinic-date filter existed, or a date since
  // removed). That must still clear the old baseline, exactly like the create
  // path does for the same input, rather than leaving the stale dates in place.
  const existing = await prisma.person.create({ data: { name: "Ada Lovelace", netId: "al99", status: "OFFBOARDED" } });
  const { term, srhd, srr, contract } = await seedSubmitted({ netId: "al99", epicNeeded: false, availability: ["2026-06-13"] });
  await prisma.term.update({
    where: { id: term.id },
    data: { clinicDates: [new Date("2026-06-06T12:00:00.000Z")] },
  });
  await prisma.termMembership.create({
    data: {
      personId: existing.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER", status: "REMOVED",
      baselineAvailability: [new Date("2026-05-30T00:00:00.000Z")],
    },
  });

  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 0, reactivated: 1, skipped: 0 });

  const membership = await prisma.termMembership.findFirstOrThrow({
    where: { personId: existing.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER" },
  });
  expect(membership.status).toBe("ACTIVE");
  expect(membership.baselineAvailability).toEqual([]);
});

it("keeps a REMOVED membership's existing baselineAvailability when the reactivating application had no availability answer", async () => {
  const existing = await prisma.person.create({ data: { name: "Ada Lovelace", netId: "al99", status: "OFFBOARDED" } });
  const { term, srhd, srr, contract } = await seedSubmitted({ netId: "al99", epicNeeded: false });
  await prisma.termMembership.create({
    data: {
      personId: existing.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER", status: "REMOVED",
      baselineAvailability: [new Date("2026-05-30T00:00:00.000Z")],
    },
  });

  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 0, reactivated: 1, skipped: 0 });

  const membership = await prisma.termMembership.findFirstOrThrow({
    where: { personId: existing.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER" },
  });
  expect(membership.status).toBe("ACTIVE");
  expect(membership.baselineAvailability.map((d) => d.toISOString())).toEqual(["2026-05-30T00:00:00.000Z"]);
});

it("leaves baselineAvailability empty when the application had no availability answer", async () => {
  const { term, srhd, srr, contract } = await seedSubmitted();
  await promoteContracts([contract.id], srr.id);
  const person = await prisma.person.findFirstOrThrow({ where: { netId: "al99" } });
  const membership = await prisma.termMembership.findFirstOrThrow({
    where: { personId: person.id, termId: term.id, departmentId: srhd.id },
  });
  expect(membership.baselineAvailability).toEqual([]);
});

describe("parseAvailabilityDates (pure)", () => {
  it("parses YYYY-MM-DD values to UTC-midnight dates", () => {
    expect(parseAvailabilityDates(["2026-05-30", "2026-06-06"]).map((d) => d.toISOString()))
      .toEqual(["2026-05-30T00:00:00.000Z", "2026-06-06T00:00:00.000Z"]);
  });
  it("accepts a single scalar string (one MULTI_SELECT checkbox)", () => {
    expect(parseAvailabilityDates("2026-05-30").map((d) => d.toISOString())).toEqual(["2026-05-30T00:00:00.000Z"]);
  });
  it("dedupes and drops malformed / non-string / empty values", () => {
    expect(parseAvailabilityDates(["2026-05-30", "2026-05-30", "not-a-date", "", "2026-13-99", 42, null]).map((d) => d.toISOString()))
      .toEqual(["2026-05-30T00:00:00.000Z"]);
  });
  it("returns [] for missing/empty answers", () => {
    expect(parseAvailabilityDates(undefined)).toEqual([]);
    expect(parseAvailabilityDates(null)).toEqual([]);
    expect(parseAvailabilityDates("")).toEqual([]);
    expect(parseAvailabilityDates([])).toEqual([]);
  });
});

it("carries dateOfBirth, dietaryRestrictions, and Epic access details onto the Person + EpicRequest", async () => {
  const { srr, contract } = await seedSubmitted({ epicNeeded: true });
  await prisma.onboardingContract.update({
    where: { id: contract.id },
    data: {
      dateOfBirth: new Date("2000-05-15T00:00:00.000Z"),
      dietaryRestrictions: "Vegetarian, nut allergy",
      epicAccessType: "Read-only",
      worksWithYnhh: true,
    },
  });
  await promoteContracts([contract.id], srr.id);
  const person = await prisma.person.findFirstOrThrow({ where: { netId: "al99" } });
  expect(person.dateOfBirth?.toISOString()).toBe("2000-05-15T00:00:00.000Z");
  expect(person.dietaryRestrictions).toBe("Vegetarian, nut allergy");
  const req = await prisma.epicRequest.findFirstOrThrow({ where: { personId: person.id, kind: "NEW" } });
  expect(req.notes).toBe("Access type: Read-only. Already works with YNHH");
});

describe("promotion carries the new contract fields (pronouns, staffTitle)", () => {
  it("sets pronouns and staffTitle on a newly created person", async () => {
    const { srr, contract } = await seedSubmitted();
    await prisma.onboardingContract.update({
      where: { id: contract.id },
      data: { pronouns: "they/them", staffTitle: "Program Manager" },
    });
    await promoteContracts([contract.id], srr.id);
    const person = await prisma.person.findFirstOrThrow({ where: { netId: "al99" } });
    expect(person.pronouns).toBe("they/them");
    expect(person.staffTitle).toBe("Program Manager");
  });

  it("does not overwrite an existing person's pronouns and staffTitle with the contract's values", async () => {
    const existing = await prisma.person.create({
      data: { name: "Ada Lovelace", netId: "al99", status: "OFFBOARDED", pronouns: "she/her", staffTitle: "Volunteer" },
    });
    const { srr, contract } = await seedSubmitted({ netId: "al99" });
    await prisma.onboardingContract.update({
      where: { id: contract.id },
      data: { pronouns: "they/them", staffTitle: "Program Manager" },
    });
    await promoteContracts([contract.id], srr.id);
    const person = await prisma.person.findUniqueOrThrow({ where: { id: existing.id } });
    expect(person.pronouns).toBe("she/her");
    expect(person.staffTitle).toBe("Volunteer");
  });

  it("sets pronouns and staffTitle from the contract when an existing person has them null", async () => {
    const existing = await prisma.person.create({
      data: { name: "Ada Lovelace", netId: "al99", status: "OFFBOARDED" },
    });
    const { srr, contract } = await seedSubmitted({ netId: "al99" });
    await prisma.onboardingContract.update({
      where: { id: contract.id },
      data: { pronouns: "they/them", staffTitle: "Program Manager" },
    });
    await promoteContracts([contract.id], srr.id);
    const person = await prisma.person.findUniqueOrThrow({ where: { id: existing.id } });
    expect(person.pronouns).toBe("they/them");
    expect(person.staffTitle).toBe("Program Manager");
  });
});
