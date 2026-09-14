import { describe, expect, it } from "vitest";
import {
  AI_REVIEW_FLAGS,
  AI_REVIEW_FLAG_LABELS,
  aiRerouteSuggestion,
  aiScoreGap,
  formatAiGap,
  matchesAiRosterFilter,
  parseAiReviewImport,
  parseAiRosterFilter,
  type AiRosterRow,
} from "./ai-review";

const validRow = {
  appId: "app1",
  score: 4,
  rank: 107,
  merit: 34,
  A: 4,
  B: 5,
  C: 3,
  D: 4,
  first_choice: "PHLO",
  first_choice_fit: 2,
  best_fit_dept: "MEDS",
  why: "Reroute to MEDS: pharmacy technician with medication-access work.",
  flags: ["licensed_professional"],
  reroute: true,
};

describe("aiRerouteSuggestion", () => {
  it("suggests the best fit when it differs from the first choice of an unrouted applicant", () => {
    expect(
      aiRerouteSuggestion({ bestFitDepartmentCode: "MEDS", routedDepartmentCode: null, departmentChoices: ["PHLO", "EDUC"] }),
    ).toEqual({ from: "PHLO", to: "MEDS" });
  });

  it("compares against the routed department once there is one, so a move already made stops being suggested", () => {
    expect(
      aiRerouteSuggestion({ bestFitDepartmentCode: "MEDS", routedDepartmentCode: "MEDS", departmentChoices: ["PHLO"] }),
    ).toBeNull();
    expect(
      aiRerouteSuggestion({ bestFitDepartmentCode: "PHLO", routedDepartmentCode: "EDUC", departmentChoices: ["PHLO"] }),
    ).toEqual({ from: "EDUC", to: "PHLO" });
  });

  it("says nothing without a best fit, and names no origin when the applicant ranked nothing", () => {
    expect(aiRerouteSuggestion({ bestFitDepartmentCode: null, routedDepartmentCode: null, departmentChoices: ["PHLO"] })).toBeNull();
    expect(aiRerouteSuggestion({ bestFitDepartmentCode: "EDUC", routedDepartmentCode: null, departmentChoices: [] })).toEqual({
      from: null,
      to: "EDUC",
    });
  });
});

describe("aiScoreGap and formatAiGap", () => {
  it("is committee minus AI, and null when either is missing", () => {
    expect(aiScoreGap(4.5, 2)).toBe(2.5);
    expect(aiScoreGap(null, 3)).toBeNull();
    expect(aiScoreGap(3, null)).toBeNull();
  });

  it("always shows a sign and one decimal", () => {
    expect(formatAiGap(2.5)).toBe("+2.5");
    expect(formatAiGap(-1.6667)).toBe("-1.7");
    expect(formatAiGap(0.04)).toBe("0.0");
  });
});

describe("roster filters", () => {
  const row = (over: Partial<AiRosterRow>): AiRosterRow => ({
    aiReview: { score: 3, bestFitDepartmentCode: "EDUC", flags: [] },
    committeeAverage: 3,
    routedDepartmentCode: null,
    departmentChoices: ["EDUC"],
    ...over,
  });

  it("parses only known filter values", () => {
    expect(parseAiRosterFilter("reroute")).toBe("reroute");
    expect(parseAiRosterFilter("nope")).toBeNull();
    expect(parseAiRosterFilter(undefined)).toBeNull();
  });

  it("reroute matches only a live suggestion", () => {
    expect(matchesAiRosterFilter(row({ departmentChoices: ["PHLO"] }), "reroute")).toBe(true);
    expect(matchesAiRosterFilter(row({}), "reroute")).toBe(false);
  });

  it("disagree needs both scores and a gap of at least two points either way", () => {
    expect(matchesAiRosterFilter(row({ committeeAverage: 5 }), "disagree")).toBe(true);
    expect(matchesAiRosterFilter(row({ committeeAverage: 1 }), "disagree")).toBe(true);
    expect(matchesAiRosterFilter(row({ committeeAverage: 4.5 }), "disagree")).toBe(false);
    expect(matchesAiRosterFilter(row({ committeeAverage: null }), "disagree")).toBe(false);
  });

  it("flagged ignores descriptive flags and catches the ones that make the score unreliable", () => {
    expect(matchesAiRosterFilter(row({ aiReview: { score: 3, bestFitDepartmentCode: "EDUC", flags: ["licensed_professional"] } }), "flagged")).toBe(false);
    expect(matchesAiRosterFilter(row({ aiReview: { score: 3, bestFitDepartmentCode: "EDUC", flags: ["needs_human_read"] } }), "flagged")).toBe(true);
  });

  it("missing matches rows the run never scored, and no other filter does", () => {
    const none = row({ aiReview: null });
    expect(matchesAiRosterFilter(none, "missing")).toBe(true);
    expect(matchesAiRosterFilter(none, "reroute")).toBe(false);
    expect(matchesAiRosterFilter(row({}), "missing")).toBe(false);
  });
});

describe("parseAiReviewImport", () => {
  it("maps a run's row into model fields, from either a list or an object keyed by id", () => {
    const fromList = parseAiReviewImport([validRow]);
    const fromObject = parseAiReviewImport({ app1: validRow });
    expect(fromList.errors).toEqual([]);
    expect(fromObject).toEqual(fromList);
    expect(fromList.rows[0]).toEqual({
      applicationId: "app1",
      score: 4,
      rank: 107,
      merit: 34,
      engagement: 4,
      skills: 5,
      effort: 3,
      reliability: 4,
      firstChoiceDepartmentCode: "PHLO",
      firstChoiceFit: 2,
      bestFitDepartmentCode: "MEDS",
      justification: "Reroute to MEDS: pharmacy technician with medication-access work.",
      flags: ["licensed_professional"],
      overrideNote: null,
    });
  });

  it("keeps an override note", () => {
    const { rows } = parseAiReviewImport([{ ...validRow, score: 1, override_1: "job-application template" }]);
    expect(rows[0].overrideNote).toBe("job-application template");
  });

  it("reports every problem in the file instead of stopping at the first", () => {
    const { rows, errors } = parseAiReviewImport([
      { ...validRow, appId: "a", score: 6 },
      { ...validRow, appId: "b", A: 2.5, flags: ["ai_written"] },
      { ...validRow, appId: "a" },
      { ...validRow, appId: "c", best_fit_dept: "not a code", why: " " },
    ]);
    expect(rows.map((r) => r.applicationId)).toEqual([]);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain("score must be a whole number from 1 to 5");
    expect(errors[1]).toContain("A must be a whole number");
    expect(errors[1]).toContain('unknown flag "ai_written"');
    expect(errors[2]).toContain("appears more than once");
    expect(errors[3]).toContain("best_fit_dept must be a department code");
    expect(errors[3]).toContain("why is missing");
  });

  it("refuses something that is not rows at all", () => {
    expect(parseAiReviewImport("nope").errors).toHaveLength(1);
    expect(parseAiReviewImport([]).errors).toEqual(["The file holds no rows."]);
  });

  it("labels every flag it accepts", () => {
    for (const flag of AI_REVIEW_FLAGS) {
      expect(AI_REVIEW_FLAG_LABELS[flag]).toMatch(/^[A-Z]/);
    }
  });
});
