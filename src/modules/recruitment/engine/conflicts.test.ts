import { describe, expect, it } from "vitest";
import { findAcceptanceConflicts } from "./conflicts";

describe("findAcceptanceConflicts", () => {
  it("returns an empty set for no acceptances", () => {
    expect(findAcceptanceConflicts([]).size).toBe(0);
  });
  it("does not flag an application accepted by a single department (even twice in the list)", () => {
    const out = findAcceptanceConflicts([
      { applicationId: "a", departmentCode: "SRHD" },
      { applicationId: "a", departmentCode: "SRHD" },
    ]);
    expect(out.has("a")).toBe(false);
  });
  it("flags an application accepted by two distinct departments", () => {
    const out = findAcceptanceConflicts([
      { applicationId: "a", departmentCode: "SRHD" },
      { applicationId: "a", departmentCode: "MDIC" },
      { applicationId: "b", departmentCode: "MDIC" },
    ]);
    expect([...out]).toEqual(["a"]);
  });
});
