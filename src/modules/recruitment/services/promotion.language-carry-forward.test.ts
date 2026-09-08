import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { promoteContracts } from "./promotion";

/**
 * Promotion must carry a pre-acceptance language verdict (Task 1's
 * ApplicationLanguageAssessment) straight onto PersonLanguage as a VERDICT,
 * not a fresh claim -- otherwise a member INTP already assessed gets put back
 * in the review queue for work already done.
 *
 * Fixtures modeled on promotion.dual-roles.test.ts's seedSubmitted: a cycle,
 * an applicant, a SUBMITTED onboarding contract for an accepted PATS
 * application, and an SRR actor with recruitment.review_all.
 */
async function seed() {
  const term = await prisma.term.create({
    data: {
      code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(),
      status: "ACTIVE", clinicDates: [],
    },
  });
  const primaryCode = "PATS";
  await prisma.department.create({ data: { code: primaryCode, name: "Patient Advocacy" } });
  await prisma.department.create({ data: { code: "INTP", name: "Interpreting and Diversity" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  // The original INTP assessor, kept distinct from the promoting SRR so the
  // test can prove the assessor is preserved rather than re-stamped.
  const assessor = await prisma.person.create({ data: { name: "INTP Reviewer", status: "ACTIVE" } });
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
      departmentChoices: [primaryCode], languagesClaimed: ["es"],
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
  return { term, srr, assessor, cycle, applicant, application, acceptance, contract, applicantName: "Ada Lovelace" };
}

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

describe("promotion carries a pre-acceptance language verdict forward", () => {
  it("writes a VERIFIED PersonLanguage keeping the original assessor and score", async () => {
    const ctx = await seed();
    await prisma.applicationLanguageAssessment.create({
      data: {
        applicationId: ctx.application.id, language: "es", verified: true,
        verifiedById: ctx.assessor.id, score: 4, verifiedAt: new Date("2026-03-01"),
      },
    });

    await promoteContracts([ctx.contract.id], ctx.srr.id);

    const person = await prisma.person.findFirstOrThrow({ where: { name: ctx.applicantName } });
    const row = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: person.id, language: "es" } },
    });
    expect(row).toMatchObject({ verified: true, score: 4, verifiedById: ctx.assessor.id });
    expect(row.verifiedAt).toEqual(new Date("2026-03-01"));
  });

  // The whole point: a member INTP already assessed must not come back round.
  it("leaves the promoted person out of the review queue", async () => {
    const ctx = await seed();
    await prisma.applicationLanguageAssessment.create({
      data: {
        applicationId: ctx.application.id, language: "es", verified: true,
        verifiedById: ctx.assessor.id, score: 4,
      },
    });

    await promoteContracts([ctx.contract.id], ctx.srr.id);

    const queued = await prisma.personLanguage.count({ where: { verifiedAt: null } });
    expect(queued).toBe(0);
  });

  it("still creates a plain claim for a language nobody assessed", async () => {
    const ctx = await seed();
    await prisma.application.update({
      where: { id: ctx.application.id }, data: { languagesClaimed: ["fr"] },
    });

    await promoteContracts([ctx.contract.id], ctx.srr.id);

    const person = await prisma.person.findFirstOrThrow({ where: { name: ctx.applicantName } });
    const row = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: person.id, language: "fr" } },
    });
    expect(row.verifiedAt).toBeNull();
    expect(row.selfReported).toBe(true);
  });
});
