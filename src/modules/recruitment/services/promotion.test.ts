import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { promoteContracts, parseAvailabilityDates } from "./promotion";
import { languageReviewWhere } from "@/platform/languages";

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

// #110: promotion creates the Person directly (bypassing people.ts normalize),
// so the applicant's raw typed netId/email must be lowercased + trimmed here to
// keep the codebase-wide lowercase-NetID invariant and stay loginable.
it("stores a NEW person's netId lowercased and trimmed", async () => {
  const { srr, contract } = await seedSubmitted({ netId: "  JDC42 ", email: " Applicant@Yale.EDU " });
  await promoteContracts([contract.id], srr.id);
  const person = await prisma.person.findFirstOrThrow({ where: { netId: "jdc42" } });
  expect(person.netId).toBe("jdc42");
  expect(person.contactEmail).toBe("applicant@yale.edu");
});

// audit 14, ONB-3. isNetIdShaped is "the single definition, so the login path and
// anything WRITING Person.netId agree on what belongs in that column" -- it feeds
// the YNHH Epic access PDF and the Teams removal CSV. Every Airtable import path
// applies it; promotion, now the primary path that creates a Person, did not. The
// value is the applicant's own keystrokes in a plain SHORT_TEXT field with no
// regex, so an email address or free text landed in that column.
it("refuses to write a netId that is not NetID-shaped, rather than storing free text", async () => {
  const { srr, contract } = await seedSubmitted({
    netId: "applicant@yale.edu",
    email: "applicant@yale.edu",
  });
  await promoteContracts([contract.id], srr.id);

  const person = await prisma.person.findFirstOrThrow({
    where: { contactEmail: "applicant@yale.edu" },
  });
  expect(person.netId).toBeNull();
  // The contract keeps what they typed, so a reviewer can still see and correct it.
  const stored = await prisma.onboardingContract.findUniqueOrThrow({ where: { id: contract.id } });
  expect(stored.netId).toBe("applicant@yale.edu");
});

it("matches an existing person despite whitespace/case in the contract netId (no duplicate)", async () => {
  const existing = await prisma.person.create({ data: { name: "Ada Lovelace", netId: "al99", status: "ACTIVE" } });
  const { srr, contract } = await seedSubmitted({ netId: "  AL99 " });
  const res = await promoteContracts([contract.id], srr.id);
  expect(res.reactivated).toBe(1);
  expect(res.created).toBe(0);
  expect(await prisma.person.count({ where: { netId: "al99" } })).toBe(1);
  expect((await prisma.person.findUniqueOrThrow({ where: { id: existing.id } })).status).toBe("ACTIVE");
});

it("creates a new ACTIVE person + membership + hipaa cert + epic request when epicNeeded", async () => {
  const { term, srhd, srr, contract } = await seedSubmitted({ epicNeeded: true });
  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 1, reactivated: 0, skipped: 0, failed: 0 });
  const person = await prisma.person.findFirstOrThrow({ where: { netId: "al99" } });
  expect(person.status).toBe("ACTIVE");
  expect(await prisma.termMembership.count({ where: { personId: person.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER" } })).toBe(1);
  expect(await prisma.hipaaCertificate.count({ where: { personId: person.id } })).toBe(1);
  expect(await prisma.epicRequest.count({ where: { personId: person.id, kind: "NEW" } })).toBe(1);
  const after = await prisma.onboardingContract.findUniqueOrThrow({ where: { id: contract.id } });
  expect(after.status).toBe("PROMOTED");
  expect(after.promotedPersonId).toBe(person.id);
});

describe("offboard convergence", () => {
  // Offboarding queues a PENDING DEACTIVATE EpicRequest. Promotion is the other
  // path that brings a Person back to ACTIVE, and it used to flip the status
  // with a bare update, so the deactivation stayed open and IT revoked Epic
  // access from somebody who had just re-joined.
  it("cancels the open DEACTIVATE request when re-onboarding an offboarded person", async () => {
    const existing = await prisma.person.create({
      data: { name: "Ada Lovelace", netId: "al99", status: "OFFBOARDED", epicId: "ABC123" },
    });
    const { srr, contract } = await seedSubmitted({ netId: "al99" });
    const deact = await prisma.epicRequest.create({
      data: { personId: existing.id, kind: "DEACTIVATE", status: "PENDING", requestedById: srr.id },
    });

    await promoteContracts([contract.id], srr.id);

    const after = await prisma.epicRequest.findUniqueOrThrow({ where: { id: deact.id } });
    expect(after.status).toBe("CANCELLED");
    expect(after.notes ?? "").toContain("reactivated");
    expect((await prisma.person.findUniqueOrThrow({ where: { id: existing.id } })).status).toBe("ACTIVE");

    // Reactivation is auditable wherever it happens, not just from /admin/people.
    const audits = await prisma.auditLog.findMany({
      where: { action: "person.reactivate", entityId: existing.id },
    });
    expect(audits).toHaveLength(1);
  });

  it("writes no reactivate audit when the person was already ACTIVE", async () => {
    const existing = await prisma.person.create({ data: { name: "Ada Lovelace", netId: "al99", status: "ACTIVE" } });
    const { srr, contract } = await seedSubmitted({ netId: "al99" });
    await promoteContracts([contract.id], srr.id);
    expect(await prisma.auditLog.count({ where: { action: "person.reactivate", entityId: existing.id } })).toBe(0);
  });

  it("leaves a SUBMITTED deactivation of an already-ACTIVE person alone", async () => {
    // Not a reactivation: no status change, so nothing to converge.
    const existing = await prisma.person.create({
      data: { name: "Ada Lovelace", netId: "al99", status: "ACTIVE", epicId: "ABC123" },
    });
    const { srr, contract } = await seedSubmitted({ netId: "al99" });
    const deact = await prisma.epicRequest.create({
      data: { personId: existing.id, kind: "DEACTIVATE", status: "SUBMITTED", requestedById: srr.id },
    });
    await promoteContracts([contract.id], srr.id);
    expect((await prisma.epicRequest.findUniqueOrThrow({ where: { id: deact.id } })).status).toBe("SUBMITTED");
  });

  // One ACTIVE membership per (person, term, department). changeMembershipKind
  // soft-removes the old row when swapping kinds; promotion used to scope its
  // lookup by kind and create a parallel ACTIVE row, which renders the person
  // twice in the schedule builder grid and double-counts them in compliance.
  it("retires an ACTIVE membership of the other kind instead of creating a second one", async () => {
    const existing = await prisma.person.create({ data: { name: "Ada Lovelace", netId: "al99", status: "ACTIVE" } });
    const { term, srhd, srr, contract } = await seedSubmitted({ netId: "al99" });
    const volunteer = await prisma.termMembership.create({
      data: { personId: existing.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    // Promote through a DIRECTOR-track cycle for the same term and department.
    await prisma.recruitmentCycle.updateMany({ where: {}, data: { track: "DIRECTOR" } });

    await promoteContracts([contract.id], srr.id);

    const active = await prisma.termMembership.findMany({
      where: { personId: existing.id, termId: term.id, departmentId: srhd.id, status: "ACTIVE" },
    });
    expect(active).toHaveLength(1);
    expect(active[0].kind).toBe("DIRECTOR");
    expect((await prisma.termMembership.findUniqueOrThrow({ where: { id: volunteer.id } })).status).toBe("REMOVED");
  });
});

describe("promote result reporting", () => {
  // `skipped` means "conflicted or not yet submitted", which an SRR reads and
  // dismisses. A contract that errored out must not hide in that number: that
  // person holds no membership and is absent from every roster for the term.
  // The three intentional skips (not SUBMITTED, conflicted acceptance,
  // unresolvable department) must stay in `skipped` and never inflate `failed`,
  // which the action now renders as an error banner.
  it("keeps the benign skips in `skipped` and leaves `failed` at zero", async () => {
    const { srr, contract } = await seedSubmitted();
    // Unresolvable department: the lookup happens before the transaction.
    await prisma.department.deleteMany({});

    const res = await promoteContracts([contract.id], srr.id);
    expect(res).toEqual({ created: 0, reactivated: 0, skipped: 1, failed: 0 });
    expect(await prisma.person.count({ where: { netId: "al99" } })).toBe(0);
  });

  it("reports a second promote of the same contract as skipped, not failed", async () => {
    const { srr, contract } = await seedSubmitted();
    const first = await promoteContracts([contract.id], srr.id);
    expect(first).toEqual({ created: 1, reactivated: 0, skipped: 0, failed: 0 });
    const second = await promoteContracts([contract.id], srr.id);
    expect(second).toEqual({ created: 0, reactivated: 0, skipped: 1, failed: 0 });
  });

  // The claim is what makes a concurrent double-promote safe: without it both
  // transactions proceed and each creates a HipaaCertificate and an EpicRequest.
  it("does not duplicate certificates or Epic requests under a concurrent promote", async () => {
    const existing = await prisma.person.create({ data: { name: "Ada Lovelace", netId: "al99", status: "ACTIVE" } });
    const { term, srhd, srr, contract } = await seedSubmitted({ netId: "al99", epicNeeded: true });
    // Membership already exists, so neither racer trips the unique key that
    // protects the new-person path.
    await prisma.termMembership.create({
      data: { personId: existing.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });

    const [a, b] = await Promise.all([
      promoteContracts([contract.id], srr.id),
      promoteContracts([contract.id], srr.id),
    ]);

    expect(a.reactivated + b.reactivated).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);
    expect(a.failed + b.failed).toBe(0);
    expect(await prisma.hipaaCertificate.count({ where: { personId: existing.id } })).toBe(1);
    expect(await prisma.epicRequest.count({ where: { personId: existing.id, kind: "NEW" } })).toBe(1);
  });
});

it("reactivates a returning person matched by netId without duplicating", async () => {
  const existing = await prisma.person.create({ data: { name: "Ada Lovelace", netId: "al99", status: "OFFBOARDED" } });
  const { srr, contract } = await seedSubmitted({ netId: "al99", epicNeeded: false });
  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 0, reactivated: 1, skipped: 0, failed: 0 });
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
  expect(res).toEqual({ created: 0, reactivated: 0, skipped: 1, failed: 0 });
  expect(await prisma.person.count({ where: { netId: "al99" } })).toBe(0);
  expect(await prisma.termMembership.count({ where: { termId: cycle.termId } })).toBe(0);
  expect((await prisma.onboardingContract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe("SUBMITTED");
});

it("skips a non-SUBMITTED contract (idempotent re-run)", async () => {
  const { srr, contract } = await seedSubmitted({ epicNeeded: false });
  await promoteContracts([contract.id], srr.id);
  const res2 = await promoteContracts([contract.id], srr.id);
  expect(res2).toEqual({ created: 0, reactivated: 0, skipped: 1, failed: 0 });
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
  expect(res).toEqual({ created: 0, reactivated: 1, skipped: 0, failed: 0 });
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
  expect(person.licensedRN).toBe(true);

  // The contract's Spanish claim becomes a self-reported PersonLanguage row.
  // Crucially NOT verified: intake states a claim, and only the interpreting
  // department can turn that into a capability that gates scheduling.
  const es = await prisma.personLanguage.findUniqueOrThrow({
    where: { personId_language: { personId: person.id, language: "es" } },
  });
  expect(es.selfReported).toBe(true);
  expect(es.verified).toBe(false);
  expect(es.verifiedAt).toBeNull();

  // verifiedAt null is exactly what puts them in the review queue.
  const queue = await prisma.personLanguage.findMany({
    where: languageReviewWhere(),
    select: { personId: true },
  });
  expect(queue.map((r) => r.personId)).toContain(person.id);
});

it("promotes a TRANSFER applicant into the accepted department, not their prior one", async () => {
  const { term, srhd, srr, contract } = await seedSubmitted({ applicantType: "TRANSFER", transferFromDepartments: ["MDIC"] });
  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 1, reactivated: 0, skipped: 0, failed: 0 });
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
  expect(res).toEqual({ created: 0, reactivated: 1, skipped: 0, failed: 0 });

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
  expect(res).toEqual({ created: 0, reactivated: 1, skipped: 0, failed: 0 });

  const memberships = await prisma.termMembership.findMany({ where: { personId: existing.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER" } });
  expect(memberships).toHaveLength(1);
  expect(memberships[0].id).toBe(active.id);
  expect(memberships[0].status).toBe("ACTIVE");
});

it("carries the application's availability answer into TermMembership.baselineAvailability", async () => {
  const { term, srhd, srr, contract } = await seedSubmitted({ availability: ["2026-05-30", "2026-06-06", "2026-06-13"] });
  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 1, reactivated: 0, skipped: 0, failed: 0 });
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
  expect(res).toEqual({ created: 0, reactivated: 1, skipped: 0, failed: 0 });

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
  expect(res).toEqual({ created: 0, reactivated: 1, skipped: 0, failed: 0 });

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
