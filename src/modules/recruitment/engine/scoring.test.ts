import { expect, it } from "vitest";
import { scoreAverage } from "./scoring";

it("returns null average and 0 count for no scores", () => {
  expect(scoreAverage([])).toEqual({ average: null, count: 0 });
});

it("averages 1-5 scores", () => {
  expect(scoreAverage([5, 4, 3])).toEqual({ average: 4, count: 3 });
});
