import { describe, expect, it } from "vitest";
import { deriveStatus, parseScore, rollupStatus } from "./status";

describe("deriveStatus", () => {
  it("treats passed and completed as COMPLETE", () => {
    expect(deriveStatus("completed")).toEqual({ status: "COMPLETE", completed: true });
    expect(deriveStatus("passed")).toEqual({ status: "COMPLETE", completed: true });
    expect(deriveStatus("PASSED")).toEqual({ status: "COMPLETE", completed: true });
  });

  it("treats failed/incomplete/browsed as IN_PROGRESS", () => {
    for (const s of ["failed", "incomplete", "browsed"]) {
      expect(deriveStatus(s)).toEqual({ status: "IN_PROGRESS", completed: false });
    }
  });

  it("treats missing/blank/not attempted as IN_PROGRESS (caller decides not-started)", () => {
    expect(deriveStatus(null).completed).toBe(false);
    expect(deriveStatus("").completed).toBe(false);
    expect(deriveStatus("not attempted").completed).toBe(false);
  });
});

describe("parseScore", () => {
  it("parses a numeric string to a rounded int", () => {
    expect(parseScore("85")).toBe(85);
    expect(parseScore("90.4")).toBe(90);
  });
  it("returns null for missing or blank", () => {
    expect(parseScore(null)).toBeNull();
    expect(parseScore("")).toBeNull();
    expect(parseScore("  ")).toBeNull();
  });
});

describe("rollupStatus", () => {
  it("is COMPLETE only when every SCO is complete", () => {
    expect(rollupStatus(["completed", "passed"]).status).toBe("COMPLETE");
    expect(rollupStatus(["completed", "incomplete"]).status).toBe("IN_PROGRESS");
    expect(rollupStatus(["completed", null]).status).toBe("IN_PROGRESS");
  });

  it("is IN_PROGRESS for an empty SCO list (nothing to complete yet)", () => {
    expect(rollupStatus([]).status).toBe("IN_PROGRESS");
    expect(rollupStatus([]).completed).toBe(false);
  });
});
