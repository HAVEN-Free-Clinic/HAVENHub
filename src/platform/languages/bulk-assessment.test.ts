import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { claimLanguage, listLanguageReviewQueue } from "./index";
import { LanguageValidationError } from "./catalog";
import {
  bulkAssessmentFlash,
  parseBulkAssessmentEntries,
  recordLanguageAssessmentsInBulk,
} from "./bulk-assessment";

const ACTOR = "bulk-actor";

beforeEach(resetDb);

async function actor() {
  return prisma.person.create({ data: { id: ACTOR, name: "Interpreter Lead" } });
}

/** One application in an open cycle. */
async function application() {
  const lead = await prisma.person.create({ data: { name: "Lead" } });
  const term = await prisma.term.create({
    data: {
      code: `T${Math.random().toString(36).slice(2, 6)}`, name: "Term",
      startDate: new Date(), endDate: new Date(), status: "ACTIVE", clinicDates: [],
    },
  });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: "Fall 2026",
      publicSlug: `s-${Math.random()}`, departments: ["PATS"],
      createdById: lead.id, status: "OPEN",
    },
  });
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace",
      email: "ada@yale.edu", emailLower: "ada@yale.edu",
    },
  });
  return prisma.application.create({
    data: {
      cycleId: cycle.id, applicantId: applicant.id, answers: {},
      applicantType: "NEW", departmentChoices: ["PATS"],
    },
  });
}

const entry = (fields: Record<string, unknown>) => JSON.stringify(fields);

describe("parseBulkAssessmentEntries", () => {
  it("refuses an empty selection", () => {
    expect(() => parseBulkAssessmentEntries([])).toThrow(LanguageValidationError);
  });

  // A row skipped here is a person the reviewer believes they just assessed.
  it("refuses anything it cannot read rather than skipping it", () => {
    for (const bad of [
      "not json",
      "null",
      entry({ source: "member", language: "es" }),
      entry({ source: "member", personId: "p" }),
      entry({ source: "someone", personId: "p", language: "es" }),
    ]) {
      expect(() => parseBulkAssessmentEntries([bad])).toThrow(LanguageValidationError);
    }
  });

  // The three states recordLanguageAssessment tells apart. Collapsing absent
  // into blank would clear a score on every non-Spanish row in the selection.
  it("keeps a member's score tri-state: absent, blank, and set", () => {
    const [absent, blank, set] = parseBulkAssessmentEntries([
      entry({ source: "member", personId: "a", language: "pt" }),
      entry({ source: "member", personId: "b", language: "es", score: "" }),
      entry({ source: "member", personId: "c", language: "es", score: "4" }),
    ]);
    expect(absent).not.toHaveProperty("score");
    expect(blank).toMatchObject({ score: null });
    expect(set).toMatchObject({ score: 4 });
  });

  it("collapses a repeated row to one entry, so nobody is notified twice", () => {
    const e = entry({ source: "applicant", applicationId: "app", language: "es", score: "3" });
    expect(parseBulkAssessmentEntries([e, e])).toEqual([
      { source: "applicant", applicationId: "app", language: "es", score: 3 },
    ]);
  });
});

describe("recordLanguageAssessmentsInBulk", () => {
  it("records every ticked member and applicant through the single-row writes", async () => {
    await actor();
    const ana = await prisma.person.create({ data: { name: "Ana Reyes" } });
    const bo = await prisma.person.create({ data: { name: "Bo Chen" } });
    await claimLanguage(ana.id, "es");
    await claimLanguage(bo.id, "pt");
    const app = await application();

    const result = await recordLanguageAssessmentsInBulk(ACTOR, {
      verified: true,
      entries: parseBulkAssessmentEntries([
        entry({ source: "member", personId: ana.id, language: "es", score: "4" }),
        entry({ source: "member", personId: bo.id, language: "pt" }),
        entry({ source: "applicant", applicationId: app.id, language: "es", score: "3" }),
      ]),
    });

    expect(result).toEqual({ recorded: 3, failed: 0, firstError: null });
    const languages = await prisma.personLanguage.findMany({
      orderBy: { language: "asc" },
      select: { language: true, verified: true, verifiedById: true, score: true },
    });
    expect(languages).toEqual([
      { language: "es", verified: true, verifiedById: ACTOR, score: 4 },
      { language: "pt", verified: true, verifiedById: ACTOR, score: null },
    ]);
    expect(
      await prisma.applicationLanguageAssessment.findFirstOrThrow({ where: { applicationId: app.id } }),
    ).toMatchObject({ verified: true, score: 3, verifiedById: ACTOR });
    expect(await prisma.auditLog.count({ where: { action: "person.language_assess" } })).toBe(2);
    expect(await listLanguageReviewQueue()).toEqual([]);
  });

  it("carries on past a row that fails, and says why", async () => {
    await actor();
    const fine = await prisma.person.create({ data: { name: "Fine" } });
    const refused = await prisma.person.create({ data: { name: "Refused" } });

    const result = await recordLanguageAssessmentsInBulk(ACTOR, {
      verified: false,
      entries: [
        // A score on a language that carries none: the single write refuses it.
        { source: "member", personId: refused.id, language: "pt", score: 4 },
        { source: "member", personId: fine.id, language: "es" },
      ],
    });

    expect(result).toMatchObject({ recorded: 1, failed: 1 });
    expect(result.firstError).toMatch(/proficiency score/);
    expect(
      await prisma.personLanguage.findUnique({
        where: { personId_language: { personId: fine.id, language: "es" } },
      }),
    ).toMatchObject({ verified: false });
    expect(await prisma.personLanguage.count({ where: { personId: refused.id } })).toBe(0);
  });
});

describe("bulkAssessmentFlash", () => {
  it("confirms a clean run with the count and the outcome", () => {
    expect(bulkAssessmentFlash({ recorded: 1, failed: 0, firstError: null }, true)).toEqual({
      ok: "Recorded 1 assessment as verified.",
    });
    expect(bulkAssessmentFlash({ recorded: 3, failed: 0, firstError: null }, false)).toEqual({
      ok: "Recorded 3 assessments as not verified.",
    });
  });

  it("reports a partial run as an error, naming the first reason", () => {
    expect(
      bulkAssessmentFlash({ recorded: 2, failed: 1, firstError: "Unknown language \"xx\"." }, true),
    ).toEqual({
      error: "Recorded 2 of 3 as verified. 1 could not be recorded. Unknown language \"xx\".",
    });
  });
});
