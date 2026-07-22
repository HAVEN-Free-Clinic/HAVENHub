import { describe, it, expect } from "vitest";
import { DEPARTMENT_RESPONSIBILITY_BLOCKS } from "./departments";

const CODES = [
  "BVHD", "CRAD", "EDUC", "EXEC", "FCRL", "FIND", "ITCM", "INTP", "LABR",
  "LCCN", "MDIC", "PATS", "PBRL", "PCAR", "PHAM", "QAQI", "REFF", "SOSE",
  "SRR", "SRHD", "VADM",
];

describe("DEPARTMENT_RESPONSIBILITY_BLOCKS", () => {
  it("covers every department exactly once", () => {
    const gated = DEPARTMENT_RESPONSIBILITY_BLOCKS.map((b) => b.visibleWhen?.value);
    expect(gated.sort()).toEqual([...CODES].sort());
  });

  // Cheap safety insurance: department gating is safety-relevant (it decides
  // which department-specific responsibilities agreement a director signs),
  // so cover the full condition shape, not just its value. A block whose
  // visibleWhen keyed on the wrong field, or used "isNot"/"isAnyOf" instead
  // of "is", would still pass the value-only assertion above while gating on
  // an entirely different (or inverted) condition.
  it("gates every block on department is <code>, not any other field or operator", () => {
    for (const b of DEPARTMENT_RESPONSIBILITY_BLOCKS) {
      expect(b.visibleWhen?.field).toBe("department");
      expect(b.visibleWhen?.op).toBe("is");
    }
  });

  it("confirms with a checkbox, not a signature", () => {
    for (const b of DEPARTMENT_RESPONSIBILITY_BLOCKS) expect(b.confirmKind).toBe("checkbox");
  });

  it("gives every block a non-empty body and a unique id", () => {
    const ids = new Set<string>();
    for (const b of DEPARTMENT_RESPONSIBILITY_BLOCKS) {
      expect(b.body.trim().length).toBeGreaterThan(0);
      expect(ids.has(b.id)).toBe(false);
      ids.add(b.id);
    }
  });

  it("states approximate hours per week in every body", () => {
    for (const b of DEPARTMENT_RESPONSIBILITY_BLOCKS) {
      expect(b.body).toMatch(/Approximate hours per week/);
    }
  });
});
