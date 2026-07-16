import { describe, it, expect } from "vitest";
import { buildSpeedScoreQueue, type SpeedScoreItem } from "./speed-score-queue";

const item = (id: string, myScore: number | null): SpeedScoreItem => ({
  applicationId: id, name: id, typeLabel: "New", myScore,
});

describe("buildSpeedScoreQueue", () => {
  const items = [item("a", null), item("b", 3), item("c", null), item("d", 5)];

  it("unscored-only queue in order, starting at 0", () => {
    const { queue, initialIndex } = buildSpeedScoreQueue(items, { includeScored: false });
    expect(queue.map((q) => q.applicationId)).toEqual(["a", "c"]);
    expect(initialIndex).toBe(0);
  });

  it("include-scored keeps all in order, starting at the first unscored", () => {
    const { queue, initialIndex } = buildSpeedScoreQueue(items, { includeScored: true });
    expect(queue.map((q) => q.applicationId)).toEqual(["a", "b", "c", "d"]);
    expect(initialIndex).toBe(0);
  });

  it("include-scored starts at first unscored even when earlier items are scored", () => {
    const scoredFirst = [item("b", 3), item("a", null), item("d", 5)];
    const { initialIndex } = buildSpeedScoreQueue(scoredFirst, { includeScored: true });
    expect(initialIndex).toBe(1);
  });

  it("all scored: include-scored keeps all, index 0; unscored-only is empty, index 0", () => {
    const allScored = [item("a", 1), item("b", 2)];
    expect(buildSpeedScoreQueue(allScored, { includeScored: true })).toEqual({ queue: allScored, initialIndex: 0 });
    expect(buildSpeedScoreQueue(allScored, { includeScored: false })).toEqual({ queue: [], initialIndex: 0 });
  });

  it("empty input yields empty queue at index 0", () => {
    expect(buildSpeedScoreQueue([], { includeScored: false })).toEqual({ queue: [], initialIndex: 0 });
    expect(buildSpeedScoreQueue([], { includeScored: true })).toEqual({ queue: [], initialIndex: 0 });
  });
});
