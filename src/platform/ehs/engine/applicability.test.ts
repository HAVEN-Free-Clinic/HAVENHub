import { describe, expect, it } from "vitest";
import {
  isFullyCompliant,
  missingTrainings,
  requiredTrainingsForMember,
  type RequirableTraining,
} from "./applicability";

function t(over: Partial<RequirableTraining> & { id: string }): RequirableTraining {
  return {
    name: over.id,
    isActive: true,
    requiredForAll: false,
    departmentIds: [],
    ...over,
  };
}

describe("requiredTrainingsForMember", () => {
  it("includes requiredForAll active trainings for any member", () => {
    const trainings = [t({ id: "a", requiredForAll: true })];
    const out = requiredTrainingsForMember({ trainings, memberDepartmentIds: ["d1"] });
    expect(out.map((x) => x.id)).toEqual(["a"]);
  });

  it("includes a training when a member department overlaps its departments", () => {
    const trainings = [t({ id: "bbp", departmentIds: ["sctp", "jctp"] })];
    expect(
      requiredTrainingsForMember({ trainings, memberDepartmentIds: ["jctp"] }).map((x) => x.id)
    ).toEqual(["bbp"]);
  });

  it("excludes a training when no department overlaps and not requiredForAll", () => {
    const trainings = [t({ id: "bbp", departmentIds: ["sctp"] })];
    expect(
      requiredTrainingsForMember({ trainings, memberDepartmentIds: ["orhi"] })
    ).toEqual([]);
  });

  it("excludes inactive trainings even when requiredForAll", () => {
    const trainings = [t({ id: "a", requiredForAll: true, isActive: false })];
    expect(requiredTrainingsForMember({ trainings, memberDepartmentIds: ["d1"] })).toEqual([]);
  });
});

describe("isFullyCompliant", () => {
  it("is true only when HIPAA compliant and no EHS gap", () => {
    expect(isFullyCompliant({ hipaaStatus: "COMPLIANT", ehsMissingCount: 0 })).toBe(true);
    expect(isFullyCompliant({ hipaaStatus: "COMPLIANT", ehsMissingCount: 2 })).toBe(false);
    expect(isFullyCompliant({ hipaaStatus: "EXPIRED", ehsMissingCount: 0 })).toBe(false);
  });
});

describe("missingTrainings", () => {
  it("returns required trainings the member has not completed", () => {
    const trainings = [
      t({ id: "a", name: "A", requiredForAll: true }),
      t({ id: "b", name: "B", requiredForAll: true }),
    ];
    const out = missingTrainings({
      trainings,
      memberDepartmentIds: ["d1"],
      completedTrainingIds: ["a"],
    });
    expect(out).toEqual([{ id: "b", name: "B" }]);
  });

  it("returns empty when all required trainings are completed", () => {
    const trainings = [t({ id: "a", name: "A", requiredForAll: true })];
    expect(
      missingTrainings({ trainings, memberDepartmentIds: ["d1"], completedTrainingIds: ["a"] })
    ).toEqual([]);
  });

  it("returns only trainings required for this member's departments", () => {
    const trainings = [
      t({ id: "sctp-only", name: "SCTP Only", departmentIds: ["sctp"] }),
      t({ id: "all", name: "All", requiredForAll: true }),
    ];
    // member is in orhi, not sctp -> sctp-only is not required
    const out = missingTrainings({
      trainings,
      memberDepartmentIds: ["orhi"],
      completedTrainingIds: [],
    });
    expect(out.map((m) => m.id)).toEqual(["all"]);
  });
});
