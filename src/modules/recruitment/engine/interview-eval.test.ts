import { describe, expect, it } from "vitest";
import { evaluationSummary, missingPanelists } from "./interview-eval";

describe("evaluationSummary", () => {
  it("counts recommendations and total", () => {
    const s = evaluationSummary([
      { recommendation: "STRONG_YES" }, { recommendation: "YES" }, { recommendation: "YES" }, { recommendation: "NO" },
    ]);
    expect(s).toEqual({ strongYes: 1, yes: 2, maybe: 0, no: 1, total: 4 });
  });
  it("is all zero for no evaluations", () => {
    expect(evaluationSummary([])).toEqual({ strongYes: 0, yes: 0, maybe: 0, no: 0, total: 0 });
  });
});

describe("missingPanelists", () => {
  it("returns panelist ids with no evaluation", () => {
    expect(missingPanelists(["a", "b", "c"], [{ evaluatorId: "b" }])).toEqual(["a", "c"]);
  });
  it("returns empty when all submitted", () => {
    expect(missingPanelists(["a"], [{ evaluatorId: "a" }])).toEqual([]);
  });
});
