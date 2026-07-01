import { describe, expect, it } from "vitest";
import {
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
});
