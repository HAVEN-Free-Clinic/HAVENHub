import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { claimLanguage, listLanguageReviewQueue, recordLanguageAssessment } from "./index";
import { recordApplicationLanguageAssessment } from "./applicant-review";
import { reviewLaterFlash, setReviewLater } from "./review-later";

beforeEach(resetDb);

async function reviewer() {
  return prisma.person.create({ data: { name: "Rita Reviewer" } });
}

async function claimant(name: string, language: string) {
  const p = await prisma.person.create({ data: { name, status: "ACTIVE" } });
  await claimLanguage(p.id, language);
  return p;
}

/** A submitted application to a pre-acceptance department, claiming Spanish: one applicant row. */
async function laneApplication() {
  const lead = await prisma.person.create({ data: { name: "Lead" } });
  await prisma.department.create({
    data: { code: "PATS", name: "Patient Services", assessLanguageBeforeAcceptance: true },
  });
  const term = await prisma.term.create({
    data: {
      code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(),
      status: "ACTIVE", clinicDates: [],
    },
  });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: "Fall 2026 Volunteers",
      publicSlug: `s-${Math.random()}`, departments: ["PATS"],
      createdById: lead.id, status: "OPEN",
    },
  });
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: cycle.id, firstName: "Zoe", lastName: "Zephyr",
      email: "zoe@yale.edu", emailLower: "zoe@yale.edu",
    },
  });
  return prisma.application.create({
    data: {
      cycleId: cycle.id, applicantId: applicant.id, answers: {},
      applicantType: "NEW", departmentChoices: ["PATS"], languagesClaimed: ["es"],
      status: "SUBMITTED", submittedAt: new Date(),
    },
  });
}

describe("review later", () => {
  it("sets a member claim aside and back again without recording a verdict", async () => {
    const rita = await reviewer();
    const ana = await claimant("Ana Reyes", "es");
    const target = { source: "member" as const, personId: ana.id, language: "es" };

    expect(await setReviewLater(rita.id, [target], true)).toBe(1);

    const [row] = await listLanguageReviewQueue();
    expect(row.reviewLater).toMatchObject({ byName: "Rita Reviewer" });
    expect(row.reviewLater?.since).toBeInstanceOf(Date);
    // Still owed an assessment: parking it is not a verdict.
    const claim = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: ana.id, language: "es" } },
    });
    expect(claim.verifiedAt).toBeNull();

    expect(await setReviewLater(rita.id, [target], false)).toBe(1);
    expect((await listLanguageReviewQueue())[0].reviewLater).toBeNull();
  });

  it("sets an applicant row aside, and recording its verdict clears it", async () => {
    const rita = await reviewer();
    const application = await laneApplication();
    const target = { source: "applicant" as const, applicationId: application.id, language: "es" };

    expect(await setReviewLater(rita.id, [target], true)).toBe(1);
    const [row] = await listLanguageReviewQueue();
    expect(row).toMatchObject({ source: "applicant", reviewLater: { byName: "Rita Reviewer" } });

    await recordApplicationLanguageAssessment(rita.id, {
      applicationId: application.id,
      language: "es",
      verified: true,
      score: 4,
    });

    expect(await listLanguageReviewQueue()).toEqual([]);
    expect(await prisma.languageReviewDeferral.count()).toBe(0);
  });

  it("clears a member's deferral when their claim is assessed", async () => {
    const rita = await reviewer();
    const bo = await claimant("Bo Chen", "pt");
    await setReviewLater(rita.id, [{ source: "member", personId: bo.id, language: "pt" }], true);

    await recordLanguageAssessment(rita.id, { personId: bo.id, language: "pt", verified: false });

    expect(await prisma.languageReviewDeferral.count()).toBe(0);
  });

  // The page a reviewer ticked from can be stale: someone else may have assessed
  // a row, or they may double-submit. Neither may report a move that did not happen.
  it("skips a row assessed in the meantime, and counts a repeat move as nothing moved", async () => {
    const rita = await reviewer();
    const settled = await claimant("Settled Sam", "pt");
    const pending = await claimant("Pending Pat", "ht");
    await recordLanguageAssessment(rita.id, { personId: settled.id, language: "pt", verified: true });
    const targets = [
      { source: "member" as const, personId: settled.id, language: "pt" },
      { source: "member" as const, personId: pending.id, language: "ht" },
    ];

    expect(await setReviewLater(rita.id, targets, true)).toBe(1);
    expect(await setReviewLater(rita.id, targets, true)).toBe(0);
  });

  it("flashes an error when nothing moved, and a count when something did", () => {
    expect(reviewLaterFlash(0, true)).toHaveProperty("error");
    expect(reviewLaterFlash(2, true)).toEqual({ ok: "Moved 2 to Review later." });
    expect(reviewLaterFlash(1, false)).toEqual({ ok: "Moved 1 back to the queue." });
  });
});
