import { describe, expect, it } from "vitest";
import { filterApplicantsByQuery, normalizeApplicantQuery } from "./applicant-search";

const row = (firstName: string, lastName: string, email: string) => ({
  applicant: { firstName, lastName, email },
});

const ROSTER = [
  row("Jane", "Doe", "jane.doe@yale.edu"),
  row("John", "Doe", "jdoe@yale.edu"),
  row("José", "Álvarez", "jose.alvarez@yale.edu"),
  row("Priya", "Ramanathan", "pr442@yale.edu"),
];

const names = (rows: typeof ROSTER) => rows.map((r) => r.applicant.firstName);

describe("normalizeApplicantQuery", () => {
  it("treats missing, empty, and whitespace-only input as no search", () => {
    expect(normalizeApplicantQuery(undefined)).toBeNull();
    expect(normalizeApplicantQuery(null)).toBeNull();
    expect(normalizeApplicantQuery("")).toBeNull();
    expect(normalizeApplicantQuery("   ")).toBeNull();
  });

  it("trims a real query", () => {
    expect(normalizeApplicantQuery("  doe  ")).toBe("doe");
  });
});

describe("filterApplicantsByQuery", () => {
  it("returns everything when there is no query", () => {
    expect(filterApplicantsByQuery(ROSTER, null)).toHaveLength(4);
  });

  it("matches a partial name, case-insensitively", () => {
    expect(names(filterApplicantsByQuery(ROSTER, "JAN"))).toEqual(["Jane"]);
  });

  it("requires every term, so a second word narrows rather than widens", () => {
    expect(names(filterApplicantsByQuery(ROSTER, "doe"))).toEqual(["Jane", "John"]);
    expect(names(filterApplicantsByQuery(ROSTER, "jane doe"))).toEqual(["Jane"]);
  });

  it("does not care what order the terms come in", () => {
    expect(names(filterApplicantsByQuery(ROSTER, "doe jane"))).toEqual(["Jane"]);
  });

  it("matches on email, which is what a forwarded message gives you", () => {
    expect(names(filterApplicantsByQuery(ROSTER, "pr442"))).toEqual(["Priya"]);
    expect(names(filterApplicantsByQuery(ROSTER, "jane.doe@yale.edu"))).toEqual(["Jane"]);
  });

  it("folds accents, so a searcher who cannot type them still finds the row", () => {
    expect(names(filterApplicantsByQuery(ROSTER, "jose"))).toEqual(["José"]);
    expect(names(filterApplicantsByQuery(ROSTER, "alvarez"))).toEqual(["José"]);
    // And the accented spelling still works, for anyone who does type it.
    expect(names(filterApplicantsByQuery(ROSTER, "josé"))).toEqual(["José"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterApplicantsByQuery(ROSTER, "nobody")).toEqual([]);
  });
});
