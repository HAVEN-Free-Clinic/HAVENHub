/**
 * Tests for the clearance banner summarizer.
 */

import { describe, it, expect } from "vitest";
import { summarizeNotCleared, type DeptBanner } from "./banner";

function vol(id: string, name: string, cleared: boolean) {
  return { id, name, cleared };
}

describe("summarizeNotCleared", () => {
  it("returns an empty array for empty input", () => {
    expect(summarizeNotCleared([])).toEqual([]);
  });

  it("omits departments where every volunteer is cleared", () => {
    const result = summarizeNotCleared([
      {
        departmentId: "d1",
        departmentName: "SCTS",
        volunteers: [vol("v1", "Alice", true), vol("v2", "Bob", true)],
      },
    ]);
    expect(result).toEqual([]);
  });

  it("includes a department that has at least one not-cleared volunteer", () => {
    const result = summarizeNotCleared([
      {
        departmentId: "d1",
        departmentName: "SCTS",
        volunteers: [vol("v1", "Alice", true), vol("v2", "Bob", false)],
      },
    ]);
    expect(result).toEqual<DeptBanner[]>([
      {
        departmentId: "d1",
        departmentName: "SCTS",
        notCleared: [{ id: "v2", name: "Bob" }],
      },
    ]);
  });

  it("lists every not-cleared volunteer in order", () => {
    const result = summarizeNotCleared([
      {
        departmentId: "d1",
        departmentName: "JCTS",
        volunteers: [
          vol("v1", "Alice", false),
          vol("v2", "Bob", false),
          vol("v3", "Carol", false),
          vol("v4", "Dan", false),
          vol("v5", "Eve", true),
        ],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].notCleared.map((v) => v.id)).toEqual(["v1", "v2", "v3", "v4"]);
  });

  it("preserves the input ordering of departments", () => {
    const result = summarizeNotCleared([
      {
        departmentId: "d2",
        departmentName: "EXEC",
        volunteers: [vol("v2", "Bob", false)],
      },
      {
        departmentId: "d1",
        departmentName: "SCTS",
        volunteers: [vol("v1", "Alice", false)],
      },
    ]);
    expect(result.map((d) => d.departmentId)).toEqual(["d2", "d1"]);
  });

  it("omits cleared departments even in a mixed list", () => {
    const result = summarizeNotCleared([
      {
        departmentId: "d1",
        departmentName: "SCTS",
        volunteers: [vol("v1", "Alice", true)],
      },
      {
        departmentId: "d2",
        departmentName: "JCTS",
        volunteers: [vol("v2", "Bob", false)],
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
    const result = summarizeNotCleared([
      { departmentId: "d1", departmentName: "EXEC", volunteers: [] },
    ]);
    expect(result).toEqual([]);
  });
});
