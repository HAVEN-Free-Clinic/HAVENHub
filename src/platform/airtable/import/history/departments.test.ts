import { describe, it, expect } from "vitest";
import { resolveDepartmentCode, resolveDepartmentCodes } from "./departments";

const known = new Set(["BVHD", "SCTP", "SCTS", "INTP", "ITCM"]);

describe("resolveDepartmentCode", () => {
  it("passes a known code straight through, case-insensitively", () => {
    expect(resolveDepartmentCode("BVHD", known)).toBe("BVHD");
    expect(resolveDepartmentCode("bvhd", known)).toBe("BVHD");
  });

  it("extracts the bracketed code from a friendly label", () => {
    expect(resolveDepartmentCode("Blood Pressure & Vascular Health (BVHD)", known)).toBe("BVHD");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveDepartmentCode("  SCTP  ", known)).toBe("SCTP");
  });

  it("returns null for blank input", () => {
    expect(resolveDepartmentCode(null, known)).toBeNull();
    expect(resolveDepartmentCode("   ", known)).toBeNull();
  });

  it("returns null for a code that is not known, rather than inventing one", () => {
    expect(resolveDepartmentCode("XXXX", known)).toBeNull();
  });
});

describe("resolveDepartmentCodes", () => {
  it("dedupes, preserves order, and reports the unmapped separately", () => {
    const out = resolveDepartmentCodes(["BVHD", "bvhd", "XXXX", null, "SCTP"], known);
    expect(out.codes).toEqual(["BVHD", "SCTP"]);
    expect(out.unmapped).toEqual(["XXXX"]);
  });
});
