import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { promoteContracts } from "./promotion";

/**
 * Promotion turns an application's declared dual-role offers into queue rows for
 * the receiving departments.
 *
 * What the receiving director can then DO with a row is platform's job and is
 * tested there (platform/dual-roles/dual-roles.test.ts). This file only asks
 * whether the right rows appear, and -- as much to the point -- that no
 * membership does.
 */

/**
 * A submitted contract for one applicant. `dualRoleDepartments` is set on the
 * Application directly, which is what submissions.ts hoists there at submit
 * (covered in submissions.test.ts).
 */
async function seedSubmitted(opts: { dualRoleDepartments?: string[]; primaryCode?: string } = {}) {
  const primaryCode = opts.primaryCode ?? "SRHD";
  const term = await prisma.term.create({
    data: {
      code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(),
      status: "ACTIVE", clinicDates: [],
    },
  });
  const [primary, vadm] = await Promise.all([
    prisma.department.create({ data: { code: primaryCode, name: primaryCode } }),
    // Present so an accepted offer has somewhere to land; not otherwise used
    // unless the test asks for a VADM offer.
    primaryCode === "VADM"
      ? Promise.resolve(null)
      : prisma.department.create({ data: { code: "VADM", name: "Vaccine Administration" } }),
  ]);
  await prisma.department.create({ data: { code: "INTP", name: "Interpreting and Diversity" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: `v-${Math.random()}`,
      departments: [primaryCode], createdById: srr.id, status: "OPEN",
    },
  });
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace",
      email: "ada@yale.edu", emailLower: "ada@yale.edu", netId: "al99",
    },
  });
  const application = await prisma.application.create({
    data: {
      cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW",
      departmentChoices: [primaryCode], dualRoleDepartments: opts.dualRoleDepartments ?? [],
    },
  });
  const acceptance = await prisma.acceptance.create({
    data: { applicationId: application.id, departmentCode: primaryCode, approvedById: srr.id },
  });
  const contract = await prisma.onboardingContract.create({
    data: {
      acceptanceId: acceptance.id, token: `t-${Math.random()}`, status: "SUBMITTED",
      firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu", netId: "al99",
      agreementSignature: "Ada", professionalismSignature: "Ada", trainingSignature: "Ada",
      initials: "AL", epicNeeded: false, submittedAt: new Date(),
    },
  });
  return { term, primary, vadm, srr, contract };
}

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

it("creates a PENDING offer for each department the application declared", async () => {
  const { srr, contract, term } = await seedSubmitted({ dualRoleDepartments: ["VADM"] });

  await promoteContracts([contract.id], srr.id);

  const offers = await prisma.dualRoleInterest.findMany({ where: { termId: term.id } });
  expect(offers).toHaveLength(1);
  expect(offers[0].departmentCode).toBe("VADM");
  expect(offers[0].status).toBe("PENDING");
  // The offer is NOT a membership: the gate is the entire point. VADM has to
  // check a vaccination licence that the application form never could.
  expect(
    await prisma.termMembership.count({
      where: { termId: term.id, department: { code: "VADM" } },
    }),
  ).toBe(0);
});

it("creates nothing when the application declared no dual role", async () => {
  const { srr, contract } = await seedSubmitted({ dualRoleDepartments: [] });
  await promoteContracts([contract.id], srr.id);
  expect(await prisma.dualRoleInterest.count()).toBe(0);
});

it("does not offer a person to the department they were accepted into", async () => {
  // Ticking "I'll also do vaccines" on an application routed to VADM would
  // otherwise ask VADM's director to add somebody already on their roster.
  const { srr, contract } = await seedSubmitted({
    primaryCode: "VADM",
    dualRoleDepartments: ["VADM", "INTP"],
  });

  await promoteContracts([contract.id], srr.id);

  const offers = await prisma.dualRoleInterest.findMany();
  expect(offers.map((o) => o.departmentCode)).toEqual(["INTP"]);
});

it("does not offer a department the person is already an active member of", async () => {
  const { srr, contract, term, vadm } = await seedSubmitted({ dualRoleDepartments: ["VADM"] });
  // A returning member who already holds the dual role from an earlier term's
  // promotion, re-stating it on this application.
  const existing = await prisma.person.create({
    data: { name: "Ada Lovelace", netId: "al99", status: "ACTIVE" },
  });
  await prisma.termMembership.create({
    data: {
      personId: existing.id, termId: term.id, departmentId: vadm!.id,
      kind: "VOLUNTEER", status: "ACTIVE",
    },
  });

  await promoteContracts([contract.id], srr.id);

  expect(await prisma.dualRoleInterest.count()).toBe(0);
});

it("does not reset a decided offer when the contract is promoted again", async () => {
  // A decision the receiving director already made must survive a re-promotion.
  // The upsert's empty update is what holds this; a plain create would either
  // throw or, written carelessly, reopen a declined offer.
  const { srr, contract, term } = await seedSubmitted({ dualRoleDepartments: ["VADM"] });
  await promoteContracts([contract.id], srr.id);
  const offer = await prisma.dualRoleInterest.findFirstOrThrow();
  await prisma.dualRoleInterest.update({
    where: { id: offer.id },
    data: { status: "DECLINED", notes: "No licence on file" },
  });

  await prisma.onboardingContract.update({
    where: { id: contract.id },
    data: { status: "SUBMITTED" },
  });
  await promoteContracts([contract.id], srr.id);

  const after = await prisma.dualRoleInterest.findMany({ where: { termId: term.id } });
  expect(after).toHaveLength(1);
  expect(after[0].status).toBe("DECLINED");
  expect(after[0].notes).toBe("No licence on file");
});
