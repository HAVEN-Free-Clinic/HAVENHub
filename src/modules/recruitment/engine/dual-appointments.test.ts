import { describe, expect, it } from "vitest";
import { isAcceptanceConflict, joinNames, onboardingAnchor } from "./dual-appointments";
import { findAcceptanceConflicts } from "./conflicts";

describe("isAcceptanceConflict", () => {
  it("is never a conflict with one department", () => {
    expect(isAcceptanceConflict(["FOOD"], [])).toBe(false);
    expect(isAcceptanceConflict(["FOOD", "FOOD"], [])).toBe(false);
  });

  it("is a conflict with two departments and no approval", () => {
    expect(isAcceptanceConflict(["FOOD", "QAQI"], [])).toBe(true);
  });

  it("is not a conflict when the second department is an approved dual appointment", () => {
    expect(isAcceptanceConflict(["FOOD", "QAQI"], ["QAQI"])).toBe(false);
  });

  it("an approved dual appointment on its own is simply an acceptance", () => {
    expect(isAcceptanceConflict(["QAQI"], ["QAQI"])).toBe(false);
  });

  it("an approval for a department that was not accepted covers nothing", () => {
    expect(isAcceptanceConflict(["FOOD", "QAQI"], ["JCTP"])).toBe(true);
  });

  it("three departments conflict even when two are approved", () => {
    expect(isAcceptanceConflict(["FOOD", "QAQI", "JCTP"], ["QAQI", "JCTP"])).toBe(true);
  });
});

describe("findAcceptanceConflicts with approved dual appointments", () => {
  const acceptances = [
    { applicationId: "a", departmentCode: "FOOD" },
    { applicationId: "a", departmentCode: "QAQI" },
    { applicationId: "b", departmentCode: "PNLC" },
    { applicationId: "b", departmentCode: "REFF" },
  ];

  it("keeps the old rule when no approvals are passed", () => {
    expect([...findAcceptanceConflicts(acceptances)].sort()).toEqual(["a", "b"]);
  });

  it("clears only the application whose second department is approved", () => {
    const conflicts = findAcceptanceConflicts(acceptances, [
      { applicationId: "a", departmentCode: "QAQI" },
      // Approved for b's department code but on a different application: covers nothing.
      { applicationId: "c", departmentCode: "REFF" },
    ]);
    expect([...conflicts]).toEqual(["b"]);
  });
});

describe("onboardingAnchor", () => {
  it("prefers the acceptance that already has a contract", () => {
    const rows = [
      { id: "1", departmentCode: "FOOD", hasContract: false },
      { id: "2", departmentCode: "QAQI", hasContract: true },
    ];
    expect(onboardingAnchor(rows, ["QAQI"])?.id).toBe("2");
  });

  it("otherwise picks the department that is not the dual appointment", () => {
    const rows = [
      { id: "2", departmentCode: "QAQI", hasContract: false },
      { id: "1", departmentCode: "FOOD", hasContract: false },
    ];
    expect(onboardingAnchor(rows, ["QAQI"])?.id).toBe("1");
  });

  it("falls back to the first acceptance, and null for none", () => {
    expect(onboardingAnchor([{ id: "2", departmentCode: "QAQI", hasContract: false }], ["QAQI"])?.id).toBe("2");
    expect(onboardingAnchor([], [])).toBeNull();
  });
});

describe("joinNames", () => {
  it("reads like a sentence", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["Food Pantry"])).toBe("Food Pantry");
    expect(joinNames(["Food Pantry", "Quality Improvement"])).toBe("Food Pantry and Quality Improvement");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
    expect(joinNames(["A", "A", ""])).toBe("A");
  });
});
