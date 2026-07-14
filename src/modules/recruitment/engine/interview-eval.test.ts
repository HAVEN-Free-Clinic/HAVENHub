import { describe, expect, it } from "vitest";
import { evaluationSummary, missingPanelists } from "./interview-eval";

describe("evaluationSummary", () => {
  it("averages scores and counts them", () => {
    const s = evaluationSummary([{ score: 5 }, { score: 4 }, { score: 4 }, { score: 1 }]);
    expect(s).toEqual({ average: 3.5, count: 4 });
  });
  it("is null average and 0 count for no evaluations", () => {
    expect(evaluationSummary([])).toEqual({ average: null, count: 0 });
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
