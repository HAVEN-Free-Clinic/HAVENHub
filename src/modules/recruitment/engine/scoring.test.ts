import { expect, it } from "vitest";
import { formatScoreSummary, scoreAverage } from "./scoring";

it("returns null average and 0 count for no scores", () => {
  expect(scoreAverage([])).toEqual({ average: null, count: 0 });
});

it("averages 1-5 scores", () => {
  expect(scoreAverage([5, 4, 3])).toEqual({ average: 4, count: 3 });
});

it("labels the average and the reviewer count", () => {
  expect(formatScoreSummary({ average: 3.7, count: 3 })).toBe("3.7 avg · 3 reviewers");
});

it("uses the singular noun for a lone reviewer", () => {
  expect(formatScoreSummary({ average: 4, count: 1 })).toBe("4.0 avg · 1 reviewer");
});

it("rounds the average to one decimal place", () => {
  expect(formatScoreSummary(scoreAverage([4, 4, 3]))).toBe("3.7 avg · 3 reviewers");
});

it("says so plainly when nobody has scored yet", () => {
  expect(formatScoreSummary({ average: null, count: 0 })).toBe("Not yet scored");
});
