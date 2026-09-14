import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import type { AiReviewImportRow } from "../engine/ai-review";
import { aiReviewForApplication, aiReviewsForCycle } from "./ai-review";
import { AiReviewImportError, importAiReviews } from "./ai-review-import";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.createMany({ data: [{ code: "EDUC", name: "Education" }, { code: "MEDS", name: "Medication Access" }] });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const scorer = await prisma.person.create({ data: { name: "Scorer", status: "ACTIVE" } });
  const leadRole = await prisma.role.create({ data: { name: "Recruitment Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  const scorerRole = await prisma.role.create({ data: { name: "Committee", grants: { create: [{ permission: "recruitment.score" }] } } });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: leadRole.id } });
  await prisma.roleAssignment.create({ data: { personId: scorer.id, roleId: scorerRole.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "Fall 2026", publicSlug: "fa26", departments: ["EDUC", "MEDS"], createdById: lead.id, status: "OPEN" } });
  const other = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "Other", publicSlug: "other", departments: ["EDUC"], createdById: lead.id, status: "OPEN" } });
  const application = async (cycleId: string, email: string, status: "SUBMITTED" | "DRAFT" = "SUBMITTED") => {
    const applicant = await prisma.applicant.create({ data: { cycleId, firstName: "A", lastName: email, email, emailLower: email } });
    return prisma.application.create({ data: { cycleId, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"], status } });
  };
  const a1 = await application(cycle.id, "one@yale.edu");
  const a2 = await application(cycle.id, "two@yale.edu");
  const draft = await application(cycle.id, "draft@yale.edu", "DRAFT");
  const elsewhere = await application(other.id, "else@yale.edu");
  return { lead, scorer, cycle, a1, a2, draft, elsewhere };
}

function row(applicationId: string, over: Partial<AiReviewImportRow> = {}): AiReviewImportRow {
  return {
    applicationId,
    score: 4,
    rank: 12,
    merit: 34,
    engagement: 4,
    skills: 5,
    effort: 3,
    reliability: 4,
    firstChoiceDepartmentCode: "EDUC",
    firstChoiceFit: 2,
    bestFitDepartmentCode: "MEDS",
    justification: "Reroute to MEDS: pharmacy technician.",
    flags: ["licensed_professional"],
    overrideNote: null,
    ...over,
  };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("importAiReviews", () => {
  it("dry-runs by default: reports the plan and writes nothing", async () => {
    const { cycle, a1 } = await seed();
    const plan = await importAiReviews({ cycleId: cycle.id, runLabel: "FA26 v2", rows: [row(a1.id)] });
    expect(plan).toMatchObject({ rows: 1, created: 1, updated: 0, unreviewed: 1, problems: [], applied: false });
    expect(await prisma.aiReview.count()).toBe(0);
  });

  it("applies, replaces a re-imported row in place, and deletes stale rows only with replace", async () => {
    const { cycle, a1, a2 } = await seed();
    await importAiReviews({ cycleId: cycle.id, runLabel: "v1", rows: [row(a1.id), row(a2.id)], apply: true });
    expect(await prisma.aiReview.count()).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: "recruitment.ai_review_import" } })).toBe(1);

    const kept = await importAiReviews({ cycleId: cycle.id, runLabel: "v2", rows: [row(a1.id, { score: 2 })], apply: true });
    expect(kept).toMatchObject({ created: 0, updated: 1, stale: 1, deleted: 0, applied: true });
    expect(await prisma.aiReview.findUnique({ where: { applicationId: a1.id } })).toMatchObject({ score: 2, runLabel: "v2" });
    expect(await prisma.aiReview.count()).toBe(2);

    const replaced = await importAiReviews({ cycleId: cycle.id, runLabel: "v3", rows: [row(a1.id)], apply: true, replace: true });
    expect(replaced).toMatchObject({ stale: 1, deleted: 1 });
    expect(await prisma.aiReview.findMany({ select: { applicationId: true } })).toEqual([{ applicationId: a1.id }]);
  });

  it("refuses the whole file when a row is outside the cycle, a draft, or routes to a department the cycle lacks", async () => {
    const { cycle, a1, draft, elsewhere } = await seed();
    const plan = await importAiReviews({
      cycleId: cycle.id,
      runLabel: "v1",
      rows: [row(a1.id), row(elsewhere.id), row(draft.id), row("missing"), row(a1.id, { bestFitDepartmentCode: "PHLO" })],
      apply: true,
    });
    expect(plan.applied).toBe(false);
    expect(plan.problems.join("\n")).toMatch(/not an application in this cycle/);
    expect(plan.problems.join("\n")).toMatch(/still a draft/);
    expect(plan.problems.join("\n")).toMatch(/best fit PHLO is not a department in this cycle/);
    expect(await prisma.aiReview.count()).toBe(0);
  });

  it("requires a run label and a real cycle", async () => {
    const { cycle, a1 } = await seed();
    const plan = await importAiReviews({ cycleId: cycle.id, runLabel: "  ", rows: [row(a1.id)], apply: true });
    expect(plan.applied).toBe(false);
    expect(plan.problems[0]).toMatch(/run label is required/);
    await expect(importAiReviews({ cycleId: "nope", runLabel: "v1", rows: [] })).rejects.toBeInstanceOf(AiReviewImportError);
  });
});

describe("reading AI reviews", () => {
  it("shows a lead every review, and a committee scorer none, so their reads stay independent", async () => {
    const { lead, scorer, cycle, a1, a2 } = await seed();
    await importAiReviews({ cycleId: cycle.id, runLabel: "v1", rows: [row(a1.id), row(a2.id)], apply: true });
    const forLead = await aiReviewsForCycle(cycle.id, lead.id);
    expect([...forLead.keys()].sort()).toEqual([a1.id, a2.id].sort());
    expect(forLead.get(a1.id)).toMatchObject({ score: 4, bestFitDepartmentCode: "MEDS", flags: ["licensed_professional"] });
    expect((await aiReviewsForCycle(cycle.id, scorer.id)).size).toBe(0);
    expect(await aiReviewForApplication(a1.id, scorer.id)).toBeNull();
    expect(await aiReviewForApplication(a1.id, lead.id)).toMatchObject({ runLabel: "v1" });
  });

  it("never shows a lead the review of their own application", async () => {
    const { lead, cycle, a1, a2 } = await seed();
    await prisma.applicant.update({ where: { id: a1.applicantId }, data: { applicantPersonId: lead.id } });
    await importAiReviews({ cycleId: cycle.id, runLabel: "v1", rows: [row(a1.id), row(a2.id)], apply: true });
    expect([...(await aiReviewsForCycle(cycle.id, lead.id)).keys()]).toEqual([a2.id]);
    expect(await aiReviewForApplication(a1.id, lead.id)).toBeNull();
  });

  it("goes with its application", async () => {
    const { cycle, a1 } = await seed();
    await importAiReviews({ cycleId: cycle.id, runLabel: "v1", rows: [row(a1.id)], apply: true });
    await prisma.application.delete({ where: { id: a1.id } });
    expect(await prisma.aiReview.count()).toBe(0);
  });
});
