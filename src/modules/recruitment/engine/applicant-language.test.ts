import { describe, expect, it } from "vitest";
import {
  EMPTY_LANGUAGE_STATUS,
  filterApplicantsByLanguage,
  isAwaitingLanguageAssessment,
  isLanguageAssessed,
  languageScoreOf,
  parseLanguageFilter,
  type RosterLanguageStatus,
} from "./applicant-language";

const awaiting: RosterLanguageStatus = { entries: [{ language: "es", verdict: null }] };
const scored: RosterLanguageStatus = {
  entries: [{ language: "es", verdict: { language: "es", verified: true, score: 4 } }],
};
const outcomeNotRecorded: RosterLanguageStatus = {
  entries: [{ language: "es", verdict: { language: "es", verified: null, score: null } }],
};
const partly: RosterLanguageStatus = {
  entries: [
    { language: "es", verdict: { language: "es", verified: true, score: 3 } },
    { language: "zh", verdict: null },
  ],
};

describe("isAwaitingLanguageAssessment", () => {
  it("is true while any language on the row is unanswered", () => {
    expect(isAwaitingLanguageAssessment(awaiting)).toBe(true);
    expect(isAwaitingLanguageAssessment(partly)).toBe(true);
  });

  it("is false once every language has a verdict", () => {
    expect(isAwaitingLanguageAssessment(scored)).toBe(false);
  });

  // The column covers every roster row, but only the lane departments assess
  // before deciding. A row assessed on nothing must not read as outstanding
  // work, or a cycle outside the lane becomes one long queue of false debt.
  it("is false for a row that is assessed on nothing", () => {
    expect(isAwaitingLanguageAssessment(EMPTY_LANGUAGE_STATUS)).toBe(false);
  });

  // A human was involved but recorded no yes/no outcome (an imported history
  // row). That is answered, not outstanding: nobody owes it a second look.
  it("counts a recorded verdict with no outcome as answered", () => {
    expect(isAwaitingLanguageAssessment(outcomeNotRecorded)).toBe(false);
  });
});

describe("isLanguageAssessed", () => {
  it("requires at least one language, so an unassessed row is neither", () => {
    expect(isLanguageAssessed(EMPTY_LANGUAGE_STATUS)).toBe(false);
    expect(isAwaitingLanguageAssessment(EMPTY_LANGUAGE_STATUS)).toBe(false);
  });

  it("is true only when nothing is outstanding", () => {
    expect(isLanguageAssessed(scored)).toBe(true);
    expect(isLanguageAssessed(partly)).toBe(false);
  });
});

describe("languageScoreOf", () => {
  it("is null when no verdict carries a score", () => {
    expect(languageScoreOf(awaiting)).toBeNull();
    expect(languageScoreOf(outcomeNotRecorded)).toBeNull();
  });

  // A scoreless verdict is not a zero: reading it as one would sort a verified
  // speaker below someone assessed at 1.
  it("takes the highest score on the row and ignores scoreless verdicts", () => {
    expect(
      languageScoreOf({
        entries: [
          { language: "es", verdict: { language: "es", verified: true, score: 3 } },
          { language: "zh", verdict: { language: "zh", verified: true, score: null } },
          { language: "fr", verdict: { language: "fr", verified: true, score: 4.5 } },
        ],
      }),
    ).toBe(4.5);
  });
});

describe("parseLanguageFilter", () => {
  it("falls back to no filter for anything unrecognised", () => {
    expect(parseLanguageFilter(undefined)).toBeNull();
    expect(parseLanguageFilter(null)).toBeNull();
    expect(parseLanguageFilter("")).toBeNull();
    expect(parseLanguageFilter("ASSESSED")).toBeNull();
  });

  it("reads the two values the filter offers", () => {
    expect(parseLanguageFilter("awaiting")).toBe("awaiting");
    expect(parseLanguageFilter("assessed")).toBe("assessed");
  });
});

describe("filterApplicantsByLanguage", () => {
  const rows = [
    { id: "waiting", status: awaiting },
    { id: "scored", status: scored },
    { id: "partly", status: partly },
    { id: "none", status: EMPTY_LANGUAGE_STATUS },
  ];
  const statusOf = (r: (typeof rows)[number]) => r.status;
  const ids = (out: typeof rows) => out.map((r) => r.id);

  it("returns everything when there is no filter", () => {
    expect(ids(filterApplicantsByLanguage(rows, statusOf, null))).toEqual([
      "waiting", "scored", "partly", "none",
    ]);
  });

  it("finds the rows a department is still waiting on", () => {
    expect(ids(filterApplicantsByLanguage(rows, statusOf, "awaiting"))).toEqual(["waiting", "partly"]);
  });

  // Neither side claims the rows assessed on nothing: they are not waiting, and
  // there is nothing on file to have assessed.
  it("finds only the fully assessed rows", () => {
    expect(ids(filterApplicantsByLanguage(rows, statusOf, "assessed"))).toEqual(["scored"]);
  });
});
