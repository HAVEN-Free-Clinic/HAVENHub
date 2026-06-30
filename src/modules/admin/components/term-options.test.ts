import { describe, it, expect } from "vitest";
import { buildTermOptions } from "./term-options";

type T = Parameters<typeof buildTermOptions>[0][number];

const term = (id: string, code: string, status: T["status"]): T => ({ id, code, status });

describe("buildTermOptions", () => {
  it("always lists Global as the first option", () => {
    const opts = buildTermOptions([]);
    expect(opts[0]).toEqual({ value: "", label: "Global" });
  });

  it("includes the active term with a plain code label", () => {
    const opts = buildTermOptions([term("t1", "SU26", "ACTIVE")]);
    expect(opts).toContainEqual({ value: "t1", label: "SU26" });
  });

  it("flags a PLANNING term as not yet active", () => {
    const opts = buildTermOptions([term("t2", "FA26", "PLANNING")]);
    expect(opts).toContainEqual({ value: "t2", label: "FA26 (not yet active)" });
  });

  it("omits ARCHIVED terms entirely (engine never honors them)", () => {
    const opts = buildTermOptions([term("t3", "SP25", "ARCHIVED")]);
    expect(opts.map((o) => o.value)).not.toContain("t3");
  });

  it("keeps the input order and only Global when no usable terms exist", () => {
    const opts = buildTermOptions([
      term("a", "SP25", "ARCHIVED"),
      term("b", "SU26", "ACTIVE"),
      term("c", "FA26", "PLANNING"),
    ]);
    expect(opts).toEqual([
      { value: "", label: "Global" },
      { value: "b", label: "SU26" },
      { value: "c", label: "FA26 (not yet active)" },
    ]);
  });
});
