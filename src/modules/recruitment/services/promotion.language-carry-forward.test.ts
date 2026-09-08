import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { termRankOf } from "@/platform/languages/assessment-terms";
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
      code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(),
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

/**
 * A person a reactivating promotion will match on netId, matching the
 * netId seed() gives the contract ("al99"), carrying a standing PersonLanguage
 * verdict for Spanish set up by the caller.
 */
async function seedExistingPerson() {
  return prisma.person.create({ data: { name: "Ada Lovelace", netId: "al99", status: "ACTIVE" } });
}

/**
 * A reviewer holding volunteers.verify_spanish globally (no term/department
 * scoping needed for a person-targeted assignment), so notifyReviewersOfPendingClaims
 * has somewhere to send a digest if "es" wrongly ends up in it.
 */
async function seedReviewer() {
  const reviewer = await prisma.person.create({ data: { name: "Spanish Reviewer", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Spanish Reviewer Role", grants: { create: [{ permission: "volunteers.verify_spanish" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: reviewer.id, roleId: role.id } });
  return reviewer;
}

beforeEach(resetDb);

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

  // The load-bearing guard: a reactivated member may already carry a NEWER
  // verdict than the one on this application (e.g. assessed again since, or
  // the application is an old one being processed late). The write must be
  // skipped so promotion cannot roll a current record back to a stale one.
  it("does not roll back a standing verdict that is newer than the application's", async () => {
    const ctx = await seed();
    const existing = await seedExistingPerson();
    const reviewer = await seedReviewer();
    const standingAssessor = await prisma.person.create({ data: { name: "Standing Assessor", status: "ACTIVE" } });
    const standingVerifiedAt = new Date("2026-06-01");
    await prisma.personLanguage.create({
      data: {
        personId: existing.id, language: "es", selfReported: true, verified: true,
        score: 5, verifiedById: standingAssessor.id, verifiedAt: standingVerifiedAt,
      },
    });
    // The mirror row this term's standing verdict already produced (the
    // history half of what recordLanguageAssessment writes together). A
    // skipped carry must leave this alone too, not just PersonLanguage.
    await prisma.spanishAssessmentRecord.create({
      data: {
        email: "", personId: existing.id, term: ctx.term.name,
        termRank: termRankOf(ctx.term.name), score: 5, verified: true,
      },
    });
    await prisma.applicationLanguageAssessment.create({
      data: {
        applicationId: ctx.application.id, language: "es", verified: true,
        verifiedById: ctx.assessor.id, score: 4, verifiedAt: new Date("2026-03-01"),
      },
    });

    await promoteContracts([ctx.contract.id], ctx.srr.id);

    const row = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: existing.id, language: "es" } },
    });
    expect(row).toMatchObject({ verified: true, score: 5, verifiedById: standingAssessor.id });
    expect(row.verifiedAt).toEqual(standingVerifiedAt);
    // The subtle half: the language is assessed either way, so it must never
    // reach the reviewer digest even though the write itself was skipped.
    const digested = await prisma.notification.count({
      where: { personId: reviewer.id, type: "volunteers.language_claimed" },
    });
    expect(digested).toBe(0);
    // CRITICAL: a skipped carry must not reach the Spanish history mirror
    // either. carryForwardApplicationAssessments returns this "es" entry with
    // written: false, and promotion.ts must filter the mirror on that flag,
    // or this row regresses from 5 to the application's stale 4.
    const history = await prisma.spanishAssessmentRecord.findUniqueOrThrow({
      where: { personId_term: { personId: existing.id, term: ctx.term.name } },
    });
    expect(history.score).toBe(5);
    expect(history.verified).toBe(true);
  });

  it("does write when the application's verdict is newer than the standing one", async () => {
    const ctx = await seed();
    const existing = await seedExistingPerson();
    const standingAssessor = await prisma.person.create({ data: { name: "Standing Assessor", status: "ACTIVE" } });
    await prisma.personLanguage.create({
      data: {
        personId: existing.id, language: "es", selfReported: true, verified: true,
        score: 2, verifiedById: standingAssessor.id, verifiedAt: new Date("2026-01-01"),
      },
    });
    const applicationVerifiedAt = new Date("2026-03-01");
    await prisma.applicationLanguageAssessment.create({
      data: {
        applicationId: ctx.application.id, language: "es", verified: true,
        verifiedById: ctx.assessor.id, score: 4, verifiedAt: applicationVerifiedAt,
      },
    });

    await promoteContracts([ctx.contract.id], ctx.srr.id);

    const row = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: existing.id, language: "es" } },
    });
    expect(row).toMatchObject({ verified: true, score: 4, verifiedById: ctx.assessor.id });
    expect(row.verifiedAt).toEqual(applicationVerifiedAt);
    // Pins the positive direction of the written flag: a carry that DOES get
    // written to PersonLanguage must also reach the Spanish history mirror,
    // or this same filter, inverted, would pass every test in this file
    // while silently disabling the mirror altogether.
    const history = await prisma.spanishAssessmentRecord.findUniqueOrThrow({
      where: { personId_term: { personId: existing.id, term: ctx.term.name } },
    });
    expect(history.score).toBe(4);
    expect(history.verified).toBe(true);
  });
});
