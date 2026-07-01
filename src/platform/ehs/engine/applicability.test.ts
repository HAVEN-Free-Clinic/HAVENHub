import { describe, expect, it } from "vitest";
import { isFullyCompliant, missingTrainings, type EhsTrainingLite } from "./applicability";

function t(over: Partial<EhsTrainingLite> & { id: string }): EhsTrainingLite {
  return { name: over.id, isActive: true, ...over };
}

describe("missingTrainings", () => {
  it("returns active trainings the person has not completed", () => {
    const trainings = [
      t({ id: "a", name: "A" }),
      t({ id: "b", name: "B" }),
    ];
    const out = missingTrainings({ trainings, completedTrainingIds: ["a"] });
    expect(out).toEqual([{ id: "b", name: "B" }]);
  });

  it("returns empty when all active trainings are completed", () => {
    const trainings = [t({ id: "a", name: "A" })];
    expect(missingTrainings({ trainings, completedTrainingIds: ["a"] })).toEqual([]);
  });

  it("excludes inactive trainings even when not completed", () => {
    const trainings = [t({ id: "a", name: "A", isActive: false })];
    expect(missingTrainings({ trainings, completedTrainingIds: [] })).toEqual([]);
  });

  it("returns all active trainings when none are completed", () => {
    const trainings = [t({ id: "x", name: "X" }), t({ id: "y", name: "Y" })];
    const out = missingTrainings({ trainings, completedTrainingIds: [] });
    expect(out.map((m) => m.id)).toEqual(["x", "y"]);
  });
});

describe("isFullyCompliant", () => {
  it("is true only when HIPAA compliant and no EHS gap", () => {
    expect(isFullyCompliant({ hipaaStatus: "COMPLIANT", ehsMissingCount: 0 })).toBe(true);
    expect(isFullyCompliant({ hipaaStatus: "COMPLIANT", ehsMissingCount: 2 })).toBe(false);
    expect(isFullyCompliant({ hipaaStatus: "EXPIRED", ehsMissingCount: 0 })).toBe(false);
  });
});
