import { describe, expect, it } from "vitest";
import {
  classifyEpicKind,
  resolveRollupNeed,
  type RollupMembership,
} from "./epic-rollup-classify";

function membership(over: Partial<RollupMembership> = {}): RollupMembership {
  return {
    departmentId: "d1",
    kind: "VOLUNTEER",
    requiresEpicDirector: "NONE",
    requiresEpicVolunteer: "NONE",
    ...over,
  };
}

describe("resolveRollupNeed", () => {
  it("needs Epic when any membership's department requires it for ALL", () => {
    const m = [membership({ requiresEpicVolunteer: "ALL" })];
    expect(resolveRollupNeed(m, { contractEpicNeeded: false, hasEpicId: false }))
      .toEqual({ needed: true, optional: false });
  });

  it("reads the director column for a director membership", () => {
    const m = [membership({ kind: "DIRECTOR", requiresEpicDirector: "ALL", requiresEpicVolunteer: "NONE" })];
    expect(resolveRollupNeed(m, { contractEpicNeeded: false, hasEpicId: false }))
      .toEqual({ needed: true, optional: false });
  });

  it("does not need Epic when every department requires NONE", () => {
    const m = [membership(), membership({ departmentId: "d2" })];
    expect(resolveRollupNeed(m, { contractEpicNeeded: true, hasEpicId: true }))
      .toEqual({ needed: false, optional: false });
  });

  it("needs Epic when one of several departments requires ALL", () => {
    const m = [membership(), membership({ departmentId: "d2", requiresEpicVolunteer: "ALL" })];
    expect(resolveRollupNeed(m, { contractEpicNeeded: false, hasEpicId: false }))
      .toEqual({ needed: true, optional: false });
  });

  it("treats SOME as decided when the onboarding contract said Epic was needed", () => {
    const m = [membership({ requiresEpicVolunteer: "SOME" })];
    expect(resolveRollupNeed(m, { contractEpicNeeded: true, hasEpicId: false }))
      .toEqual({ needed: true, optional: false });
  });

  it("treats SOME as decided when the person already has an Epic ID", () => {
    const m = [membership({ requiresEpicVolunteer: "SOME" })];
    expect(resolveRollupNeed(m, { contractEpicNeeded: false, hasEpicId: true }))
      .toEqual({ needed: true, optional: false });
  });

  it("marks SOME with no signal as optional rather than dropping the person", () => {
    const m = [membership({ requiresEpicVolunteer: "SOME" })];
    expect(resolveRollupNeed(m, { contractEpicNeeded: false, hasEpicId: false }))
      .toEqual({ needed: true, optional: true });
  });

  it("prefers ALL over SOME when the person holds both", () => {
    const m = [
      membership({ requiresEpicVolunteer: "SOME" }),
      membership({ departmentId: "d2", requiresEpicVolunteer: "ALL" }),
    ];
    expect(resolveRollupNeed(m, { contractEpicNeeded: false, hasEpicId: false }))
      .toEqual({ needed: true, optional: false });
  });

  it("does not need Epic with no memberships at all", () => {
    expect(resolveRollupNeed([], { contractEpicNeeded: true, hasEpicId: true }))
      .toEqual({ needed: false, optional: false });
  });
});

describe("classifyEpicKind", () => {
  it("is NEW with no Epic ID", () => {
    expect(classifyEpicKind({ hasEpicId: false, termDepartmentIds: ["a"], priorDepartmentIds: ["a"] }))
      .toBe("NEW");
  });

  it("is NEW with no Epic ID even for a first-time member", () => {
    expect(classifyEpicKind({ hasEpicId: false, termDepartmentIds: ["a"], priorDepartmentIds: null }))
      .toBe("NEW");
  });

  it("is MODIFY for an existing Epic ID with no prior HAVEN term", () => {
    expect(classifyEpicKind({ hasEpicId: true, termDepartmentIds: ["a"], priorDepartmentIds: null }))
      .toBe("MODIFY");
  });

  it("is MODIFY when a department was added", () => {
    expect(classifyEpicKind({ hasEpicId: true, termDepartmentIds: ["a", "b"], priorDepartmentIds: ["a"] }))
      .toBe("MODIFY");
  });

  it("is MODIFY when a department was dropped", () => {
    expect(classifyEpicKind({ hasEpicId: true, termDepartmentIds: ["a"], priorDepartmentIds: ["a", "b"] }))
      .toBe("MODIFY");
  });

  it("is MODIFY when the department was swapped", () => {
    expect(classifyEpicKind({ hasEpicId: true, termDepartmentIds: ["b"], priorDepartmentIds: ["a"] }))
      .toBe("MODIFY");
  });

  it("is RENEW when the department set is unchanged", () => {
    expect(classifyEpicKind({ hasEpicId: true, termDepartmentIds: ["a"], priorDepartmentIds: ["a"] }))
      .toBe("RENEW");
  });

  it("is RENEW when the same departments are listed in a different order", () => {
    expect(classifyEpicKind({ hasEpicId: true, termDepartmentIds: ["b", "a"], priorDepartmentIds: ["a", "b"] }))
      .toBe("RENEW");
  });
});
