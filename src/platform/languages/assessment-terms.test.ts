/**
 * The term-ordering rule.
 *
 * The bug this pins: assessment records carry a free-text term label, and
 * ordering on that label as text puts "Summer 2012" ahead of "Fall 2026",
 * because 'S' > 'F'. The profile badge used that ordering to pick someone's
 * "most recent" score, so it could show an assessment from over a decade ago.
 */

import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_SEASONS,
  UNRANKED_TERM,
  formatTermLabel,
  normalizeTermLabel,
  parseTermLabel,
  termRankOf,
} from "./assessment-terms";

describe("parseTermLabel", () => {
  it("parses a season and year", () => {
    expect(parseTermLabel("Spring 2012")).toEqual({ season: "Spring", year: 2012 });
  });

  it("is case- and whitespace-insensitive", () => {
    expect(parseTermLabel("  fall   2026 ")).toEqual({ season: "Fall", year: 2026 });
  });

  it("rejects a season it does not know", () => {
    expect(parseTermLabel("Autumn 2026")).toBeNull();
  });

  it("rejects a year that is not four digits", () => {
    expect(parseTermLabel("Spring 26")).toBeNull();
  });

  it("rejects free text", () => {
    expect(parseTermLabel("Unknown")).toBeNull();
  });
});

describe("termRankOf", () => {
  it("orders across years", () => {
    expect(termRankOf("Fall 2026")).toBeGreaterThan(termRankOf("Spring 2015"));
  });

  it("orders seasons within a year", () => {
    const ranks = ASSESSMENT_SEASONS.map((s) => termRankOf(`${s} 2026`));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("ranks Fall 2026 above Summer 2012, which text ordering got backwards", () => {
    // The exact pair that made the profile badge wrong: as text, "Summer 2012"
    // sorts first under DESC and wins "most recent".
    expect("Summer 2012" > "Fall 2026").toBe(true);
    expect(termRankOf("Fall 2026")).toBeGreaterThan(termRankOf("Summer 2012"));
  });

  it("sorts a realistic set the way a human would", () => {
    const labels = ["Summer 2012", "Spring 2026", "Spring 2015", "Fall 2026", "Fall 2012"];
    const newestFirst = [...labels].sort((a, b) => termRankOf(b) - termRankOf(a));
    expect(newestFirst).toEqual([
      "Fall 2026",
      "Spring 2026",
      "Spring 2015",
      "Fall 2012",
      "Summer 2012",
    ]);
  });

  it("gives an unparseable label the lowest rank so it never wins most-recent", () => {
    expect(termRankOf("Unknown")).toBe(UNRANKED_TERM);
    expect(termRankOf("Unknown")).toBeLessThan(termRankOf("Spring 2012"));
  });
});

describe("normalizeTermLabel", () => {
  it("canonicalises casing and spacing so imported and typed rows agree", () => {
    expect(normalizeTermLabel("  spring   2026 ")).toBe("Spring 2026");
  });

  it("leaves an unparseable label alone apart from trimming", () => {
    expect(normalizeTermLabel("  Unknown  ")).toBe("Unknown");
  });

  it("round-trips a formatted label", () => {
    expect(normalizeTermLabel(formatTermLabel("Fall", 2026))).toBe("Fall 2026");
  });
});
