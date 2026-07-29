import { describe, it, expect } from "vitest";
import { departmentChoiceOptions } from "./department-options";

describe("departmentChoiceOptions", () => {
  it("resolves each code to its Department.name", () => {
    const out = departmentChoiceOptions(
      ["SRHD", "MDIC"],
      [
        { code: "SRHD", name: "Sexual & Reproductive Health" },
        { code: "MDIC", name: "Medical" },
      ],
    );
    expect(out).toEqual([
      { value: "SRHD", label: "Sexual & Reproductive Health" },
      { value: "MDIC", label: "Medical" },
    ]);
  });

  it("preserves the order of cycle.departments rather than sorting", () => {
    const out = departmentChoiceOptions(
      ["MDIC", "SRHD"],
      [
        { code: "SRHD", name: "Sexual & Reproductive Health" },
        { code: "MDIC", name: "Medical" },
      ],
    );
    expect(out.map((o) => o.value)).toEqual(["MDIC", "SRHD"]);
  });

  it("falls back to the code as its own label when no Department row matches", () => {
    const out = departmentChoiceOptions(["ZZZZ"], [{ code: "SRHD", name: "Sexual & Reproductive Health" }]);
    expect(out).toEqual([{ value: "ZZZZ", label: "ZZZZ" }]);
  });

  it("returns an empty list when the cycle has no departments", () => {
    expect(departmentChoiceOptions([], [{ code: "SRHD", name: "Sexual & Reproductive Health" }])).toEqual([]);
  });
});
