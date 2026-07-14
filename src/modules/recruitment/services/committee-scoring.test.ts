import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { submitCommitteeScore, committeeScoreSummary, CommitteeScoreError } from "./committee-scoring";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  const scorer = await prisma.person.create({ data: { name: "Scorer", status: "ACTIVE" } });
  const scorer2 = await prisma.person.create({ data: { name: "Scorer2", status: "ACTIVE" } });
  const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Committee", grants: { create: [{ permission: "recruitment.score" }] } } });
  await prisma.roleAssignment.create({ data: { personId: scorer.id, roleId: role.id } });
  await prisma.roleAssignment.create({ data: { personId: scorer2.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC"], createdById: scorer.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email: "a@y.edu", emailLower: "a@y.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  return { scorer, scorer2, outsider, application };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("submitCommitteeScore", () => {
  it("upserts one score per reviewer and audits", async () => {
    const { scorer, application } = await seed();
    await submitCommitteeScore(application.id, scorer.id, 3, "ok");
    await submitCommitteeScore(application.id, scorer.id, 5, "changed my mind");
    const rows = await prisma.committeeScore.findMany({ where: { applicationId: application.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(5);
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.committee_score" } });
    expect(audit).not.toBeNull();
  });

  it("rejects a non-scorer", async () => {
    const { outsider, application } = await seed();
    await expect(submitCommitteeScore(application.id, outsider.id, 4, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("rejects a scorer scoring their own application (separation of duties)", async () => {
    const { scorer, application } = await seed();
    // The scorer is also the applicant (e.g. a returning member on the committee).
    await prisma.applicant.update({ where: { id: application.applicantId }, data: { applicantPersonId: scorer.id } });
    await expect(submitCommitteeScore(application.id, scorer.id, 5, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("rejects self-scoring on a director-track cycle too (SoD applies on both tracks)", async () => {
    // The motivating case: a director renewing their own membership who is also
    // on the scoring committee must not score their own director-track application.
    const { scorer } = await seed();
    const term = await prisma.term.create({ data: { code: "FA26DS", name: "FDS", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
    const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "DS", publicSlug: "ds", departments: ["EDUC"], createdById: scorer.id, status: "OPEN" } });
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Self", lastName: "Dir", email: "self@y.edu", emailLower: "self@y.edu", applicantPersonId: scorer.id } });
    const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "RENEWAL", departmentChoices: ["EDUC"], status: "SUBMITTED" } });
    await expect(submitCommitteeScore(application.id, scorer.id, 4, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("rejects an out-of-range score", async () => {
    const { scorer, application } = await seed();
    await expect(submitCommitteeScore(application.id, scorer.id, 6, null)).rejects.toBeInstanceOf(CommitteeScoreError);
  });

  it("allows scoring on a director-track cycle (committee scoring applies to both tracks)", async () => {
    const { scorer } = await seed();
    const term = await prisma.term.create({ data: { code: "FA26D", name: "Fall Director", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
    const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["EDUC"], createdById: scorer.id, status: "OPEN" } });
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "C", lastName: "D", email: "c@y.edu", emailLower: "c@y.edu" } });
    const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"], status: "SUBMITTED" } });
    const saved = await submitCommitteeScore(application.id, scorer.id, 4, null);
    expect(saved.score).toBe(4);
  });
});

describe("committeeScoreSummary", () => {
  it("averages every reviewer's score", async () => {
    const { scorer, scorer2, application } = await seed();
    await submitCommitteeScore(application.id, scorer.id, 4, null);
    await submitCommitteeScore(application.id, scorer2.id, 2, null);
    const summary = await committeeScoreSummary(application.id);
    expect(summary.count).toBe(2);
    expect(summary.average).toBe(3);
  });
});
