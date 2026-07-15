import { describe, expect, it } from "vitest";
import { bucketByPercentile } from "./route-buckets";

// Helper: build items from a list of averages; ids are "a0","a1",... in input order.
function items(avgs: (number | null)[]) {
  return avgs.map((average, i) => ({ applicationId: `a${i}`, average }));
}

describe("bucketByPercentile", () => {
  it("returns everything as middle when both percentages are 0", () => {
    const r = bucketByPercentile({ items: items([5, 4, 3, 2, 1]), topPercent: 0, bottomPercent: 0 });
    expect(r.top).toEqual([]);
    expect(r.bottom).toEqual([]);
    expect(r.middle).toHaveLength(5);
    expect(r.unscored).toEqual([]);
  });

  it("puts null-average items in unscored and excludes them from ranking", () => {
    const r = bucketByPercentile({ items: items([5, null, 1]), topPercent: 50, bottomPercent: 50 });
    expect(r.unscored).toEqual(["a1"]);
    expect(r.top).toEqual(["a0"]);
    expect(r.bottom).toEqual(["a2"]);
    expect(r.middle).toEqual([]);
  });

  it("buckets a clean spread of 10 by 20/30", () => {
    // sorted desc: 4.5,4.5,4.0,3.5,3.0,3.0,2.5,2.0,2.0,2.0
    const r = bucketByPercentile({
      items: items([4.5, 4.5, 4.0, 3.5, 3.0, 3.0, 2.5, 2.0, 2.0, 2.0]),
      topPercent: 20,
      bottomPercent: 30,
    });
    expect(r.top).toHaveLength(2); // both 4.5s
    expect(r.bottom).toHaveLength(3); // the three 2.0s
    expect(r.middle).toHaveLength(5);
  });

  it("never splits a tie: a boundary tie grows the top tier", () => {
    // 3,3,3,3,3,1 with top 20 / bottom 30: nominal top 1, but all five 3s tie.
    const r = bucketByPercentile({ items: items([3, 3, 3, 3, 3, 1]), topPercent: 20, bottomPercent: 30 });
    expect(r.top).toHaveLength(5);
    expect(r.bottom).toEqual(["a5"]); // only the 1
    expect(r.middle).toEqual([]);
  });

  it("spares a straddling tie at the reject line (favor the applicant)", () => {
    // 5,3,3,3,3,1 with top 20 / bottom 50: nominal bottom 3 lands inside the 3-tie
    // that also sits above the line, so the 3s move to middle and only the 1 is bottom.
    const r = bucketByPercentile({ items: items([5, 3, 3, 3, 3, 1]), topPercent: 20, bottomPercent: 50 });
    expect(r.top).toEqual(["a0"]);
    expect(r.bottom).toEqual(["a5"]);
    expect(r.middle).toHaveLength(4);
  });

  it("keeps a clean bottom tie in the bottom tier", () => {
    // 5,4,3,2,2,2 with top 20 / bottom 30: the 2-tie does not straddle (3 is above), so it stays bottom-eligible.
    const r = bucketByPercentile({ items: items([5, 4, 3, 2, 2, 2]), topPercent: 20, bottomPercent: 30 });
    expect(r.top).toEqual(["a0"]);
    expect(r.bottom).toEqual(["a3", "a4", "a5"]); // the three 2.0s
  });

  it("rejects nobody when every average is equal", () => {
    const r = bucketByPercentile({ items: items([3, 3, 3, 3]), topPercent: 20, bottomPercent: 30 });
    expect(r.top).toHaveLength(4);
    expect(r.bottom).toEqual([]);
    expect(r.middle).toEqual([]);
  });

  it("clamps so top and bottom never overlap on tiny N", () => {
    const r = bucketByPercentile({ items: items([5, 1]), topPercent: 50, bottomPercent: 50 });
    expect(r.top).toEqual(["a0"]);
    expect(r.bottom).toEqual(["a1"]);
    expect(r.middle).toEqual([]);
  });

  it("returns empty buckets for no scored items", () => {
    const r = bucketByPercentile({ items: items([null, null]), topPercent: 20, bottomPercent: 30 });
    expect(r.top).toEqual([]);
    expect(r.middle).toEqual([]);
    expect(r.bottom).toEqual([]);
    expect(r.unscored).toHaveLength(2);
  });

  it("orders each bucket by average descending, ties by id ascending", () => {
    const r = bucketByPercentile({ items: items([2, 5, 5, 1]), topPercent: 50, bottomPercent: 50 });
    // sorted desc, id asc on ties: a1(5), a2(5), a0(2), a3(1)
    expect(r.top).toEqual(["a1", "a2"]);
    expect(r.bottom).toEqual(["a0", "a3"]);
  });
});
