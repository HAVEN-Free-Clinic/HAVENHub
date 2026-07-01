import { describe, expect, it } from "vitest";
import {
  isFullyCompliant,
  isStudentAffiliation,
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

describe("isStudentAffiliation", () => {
  it("returns true for Yale school affiliations", () => {
    expect(isStudentAffiliation("Yale College")).toBe(true);
    expect(isStudentAffiliation("Yale School of Nursing (YSN)")).toBe(true);
  });

  it("returns false for non-student affiliations", () => {
    expect(isStudentAffiliation("Yale Staff")).toBe(false);
    expect(isStudentAffiliation("Other Yale Affiliation")).toBe(false);
  });

  it("returns false for blank or null affiliation", () => {
    expect(isStudentAffiliation(null)).toBe(false);
    expect(isStudentAffiliation("")).toBe(false);
    expect(isStudentAffiliation(undefined)).toBe(false);
  });
});

describe("requiredTrainingsForMember", () => {
  it("includes requiredForAll active trainings for any member", () => {
    const trainings = [t({ id: "a", requiredForAll: true })];
    const out = requiredTrainingsForMember({
      trainings,
      memberDepartmentIds: ["d1"],
      isStudent: false,
    });
    expect(out.map((x) => x.id)).toEqual(["a"]);
  });

  it("includes a training when a member department overlaps its departments", () => {
    const trainings = [t({ id: "bbp", departmentIds: ["sctp", "jctp"] })];
    expect(
      requiredTrainingsForMember({
        trainings,
        memberDepartmentIds: ["jctp"],
        isStudent: false,
      }).map((x) => x.id)
    ).toEqual(["bbp"]);
  });

  it("excludes a training when no department overlaps and not requiredForAll", () => {
    const trainings = [t({ id: "bbp", departmentIds: ["sctp"] })];
    expect(
      requiredTrainingsForMember({
        trainings,
        memberDepartmentIds: ["orhi"],
        isStudent: false,
      })
    ).toEqual([]);
  });

  it("excludes inactive trainings even when requiredForAll", () => {
    const trainings = [t({ id: "a", requiredForAll: true, isActive: false })];
    expect(
      requiredTrainingsForMember({ trainings, memberDepartmentIds: ["d1"], isStudent: false })
    ).toEqual([]);
  });

  describe("BBP student/clinical split", () => {
    const bbpClinical = t({ id: "ehs_bbp_clinical", requiredForAll: true });
    const bbpStudent = t({ id: "ehs_bbp_student", requiredForAll: true });
    const other = t({ id: "other", requiredForAll: true });

    it("a student gets BBP Student but NOT BBP Clinical", () => {
      const out = requiredTrainingsForMember({
        trainings: [bbpClinical, bbpStudent, other],
        memberDepartmentIds: ["d1"],
        isStudent: true,
      }).map((x) => x.id);
      expect(out).toContain("ehs_bbp_student");
      expect(out).not.toContain("ehs_bbp_clinical");
      expect(out).toContain("other");
    });

    it("a non-student gets BBP Clinical but NOT BBP Student", () => {
      const out = requiredTrainingsForMember({
        trainings: [bbpClinical, bbpStudent, other],
        memberDepartmentIds: ["d1"],
        isStudent: false,
      }).map((x) => x.id);
      expect(out).toContain("ehs_bbp_clinical");
      expect(out).not.toContain("ehs_bbp_student");
      expect(out).toContain("other");
    });

    it("non-BBP trainings are unaffected by isStudent", () => {
      const nonBbp = t({ id: "fire-safety", requiredForAll: true });
      const outStudent = requiredTrainingsForMember({
        trainings: [nonBbp],
        memberDepartmentIds: ["d1"],
        isStudent: true,
      });
      const outNonStudent = requiredTrainingsForMember({
        trainings: [nonBbp],
        memberDepartmentIds: ["d1"],
        isStudent: false,
      });
      expect(outStudent.map((x) => x.id)).toEqual(["fire-safety"]);
      expect(outNonStudent.map((x) => x.id)).toEqual(["fire-safety"]);
    });
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
      isStudent: false,
    });
    expect(out).toEqual([{ id: "b", name: "B" }]);
  });

  it("returns empty when all required trainings are completed", () => {
    const trainings = [t({ id: "a", name: "A", requiredForAll: true })];
    expect(
      missingTrainings({
        trainings,
        memberDepartmentIds: ["d1"],
        completedTrainingIds: ["a"],
        isStudent: false,
      })
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
      isStudent: false,
    });
    expect(out.map((m) => m.id)).toEqual(["all"]);
  });
});
