/**
 * The interpreting bar: what score a department will staff.
 *
 * 4 clinic-wide, per the interpreting directors. Departments that take
 * conversational speakers (PATS and BHVD at the time this was specced, with LABR
 * undecided) set their own lower number, which is why the bar is a per-department
 * column rather than a constant: the list was still moving, and it must be
 * changeable without a deploy.
 *
 * Pure module, no database. The badge on the schedule and the service that builds
 * the flag cross-check both read these, so they cannot disagree about what
 * "clears the bar" means.
 */

import { describe, expect, it } from "vitest";
import {
  CLINIC_WIDE_INTERPRETER_MIN_SCORE,
  SPANISH_PROFICIENCY_LEVELS,
  formatSpanishScore,
  interpreterBarFor,
  meetsInterpreterBar,
  spanishProficiencyLabel,
  spanishScoreTone,
} from "./catalog";

describe("interpreterBarFor", () => {
  it("uses the department's own bar when it has one", () => {
    expect(interpreterBarFor({ minInterpreterScore: 3 })).toBe(3);
  });

  it("falls back to the clinic-wide bar when the department sets none", () => {
    expect(interpreterBarFor({ minInterpreterScore: null })).toBe(
      CLINIC_WIDE_INTERPRETER_MIN_SCORE,
    );
  });

  it("falls back for a missing department, so a non-scoped caller still gets a number", () => {
    expect(interpreterBarFor(null)).toBe(CLINIC_WIDE_INTERPRETER_MIN_SCORE);
    expect(interpreterBarFor(undefined)).toBe(CLINIC_WIDE_INTERPRETER_MIN_SCORE);
  });

  it("puts the clinic-wide bar at 4, which is what INTP asked for", () => {
    expect(CLINIC_WIDE_INTERPRETER_MIN_SCORE).toBe(4);
  });
});

describe("meetsInterpreterBar", () => {
  it("clears at or above the bar", () => {
    expect(meetsInterpreterBar(4, 4)).toBe(true);
    expect(meetsInterpreterBar(5, 4)).toBe(true);
  });

  it("does not clear below it", () => {
    expect(meetsInterpreterBar(3, 4)).toBe(false);
    expect(meetsInterpreterBar(1, 4)).toBe(false);
  });

  it("clears a 3 against a department that accepts conversational speakers", () => {
    expect(meetsInterpreterBar(3, 3)).toBe(true);
  });

  // INTP verified speakers for years without always recording a number, so an
  // absent score is not a failure. Reading it as one would mark most of the
  // historical roster as below the bar.
  it("treats an unscored speaker as clearing, not failing", () => {
    expect(meetsInterpreterBar(null, 5)).toBe(true);
  });
});

describe("score presentation", () => {
  it("labels every point on the scale", () => {
    for (const level of SPANISH_PROFICIENCY_LEVELS) {
      expect(spanishProficiencyLabel(level.score)).toBe(level.label);
    }
  });

  it("covers exactly 1 through 5", () => {
    expect(SPANISH_PROFICIENCY_LEVELS.map((l) => l.score)).toEqual([1, 2, 3, 4, 5]);
  });

  it("renders an empty label rather than a guess for no score", () => {
    expect(spanishProficiencyLabel(null)).toBe("");
  });

  it("renders an imported modifier", () => {
    expect(formatSpanishScore(3, "plus")).toBe("3+");
    expect(formatSpanishScore(3, "minus")).toBe("3-");
    expect(formatSpanishScore(3, null)).toBe("3");
  });

  it("says 'Not scored' rather than showing an empty chip", () => {
    expect(formatSpanishScore(null, null)).toBe("Not scored");
    expect(formatSpanishScore(null, "plus")).toBe("Not scored");
  });

  it("tones the scale around the clinic-wide bar", () => {
    expect(spanishScoreTone(5)).toBe("success");
    expect(spanishScoreTone(4)).toBe("success");
    expect(spanishScoreTone(3)).toBe("warning");
    expect(spanishScoreTone(2)).toBe("critical");
    expect(spanishScoreTone(1)).toBe("critical");
    expect(spanishScoreTone(null)).toBe("default");
  });

  it("keeps the tone split aligned with the bar rather than hardcoding 4", () => {
    expect(spanishScoreTone(CLINIC_WIDE_INTERPRETER_MIN_SCORE)).toBe("success");
    expect(spanishScoreTone(CLINIC_WIDE_INTERPRETER_MIN_SCORE - 1)).toBe("warning");
  });
});
