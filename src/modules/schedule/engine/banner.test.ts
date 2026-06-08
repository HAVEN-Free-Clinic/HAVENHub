/**
 * Tests for the HIPAA compliance banner summarizer.
 *
 * New module (no legacy equivalent); TDD from scratch.
 */

import { describe, it, expect } from "vitest";
import { summarizeNonCompliant, type DeptBanner } from "./banner";
import type { ComplianceStatus } from "@/platform/compliance/rules";

function vol(id: string, name: string, status: ComplianceStatus) {
  return { id, name, status };
}

describe("summarizeNonCompliant", () => {
  it("returns an empty array for empty input", () => {
    expect(summarizeNonCompliant([])).toEqual([]);
  });

  it("omits departments where every volunteer is COMPLIANT", () => {
    const result = summarizeNonCompliant([
      {
        departmentId: "d1",
        departmentName: "SCTS",
        volunteers: [vol("v1", "Alice", "COMPLIANT"), vol("v2", "Bob", "COMPLIANT")],
      },
    ]);
    expect(result).toEqual([]);
  });

  it("includes a department that has at least one non-compliant volunteer", () => {
    const result = summarizeNonCompliant([
      {
        departmentId: "d1",
        departmentName: "SCTS",
        volunteers: [vol("v1", "Alice", "COMPLIANT"), vol("v2", "Bob", "EXPIRED")],
      },
    ]);
    expect(result).toEqual<DeptBanner[]>([
      {
        departmentId: "d1",
        departmentName: "SCTS",
        nonCompliant: [{ id: "v2", name: "Bob" }],
      },
    ]);
  });

  it("treats EXPIRED, EXPIRING_SOON, UNKNOWN_DATE, and NO_CERTIFICATE all as non-compliant", () => {
    const result = summarizeNonCompliant([
      {
        departmentId: "d1",
        departmentName: "JCTS",
        volunteers: [
          vol("v1", "Alice", "EXPIRED"),
          vol("v2", "Bob", "EXPIRING_SOON"),
          vol("v3", "Carol", "UNKNOWN_DATE"),
          vol("v4", "Dan", "NO_CERTIFICATE"),
          vol("v5", "Eve", "COMPLIANT"),
        ],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].nonCompliant.map((v) => v.id)).toEqual(["v1", "v2", "v3", "v4"]);
  });

  it("preserves the input ordering of departments", () => {
    const result = summarizeNonCompliant([
      {
        departmentId: "d2",
        departmentName: "EXEC",
        volunteers: [vol("v2", "Bob", "EXPIRED")],
      },
      {
        departmentId: "d1",
        departmentName: "SCTS",
        volunteers: [vol("v1", "Alice", "EXPIRING_SOON")],
      },
    ]);
    expect(result.map((d) => d.departmentId)).toEqual(["d2", "d1"]);
  });

  it("omits compliant departments even in a mixed list", () => {
    const result = summarizeNonCompliant([
      {
        departmentId: "d1",
        departmentName: "SCTS",
        volunteers: [vol("v1", "Alice", "COMPLIANT")],
      },
      {
        departmentId: "d2",
        departmentName: "JCTS",
        volunteers: [vol("v2", "Bob", "EXPIRED")],
      },
      {
        departmentId: "d3",
        departmentName: "CCRH",
        volunteers: [],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].departmentId).toBe("d2");
  });

  it("handles a department with zero volunteers (omits it)", () => {
    const result = summarizeNonCompliant([
      { departmentId: "d1", departmentName: "EXEC", volunteers: [] },
    ]);
    expect(result).toEqual([]);
  });
});
