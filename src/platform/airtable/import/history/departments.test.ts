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

  describe("DEPARTMENT_ALIASES", () => {
    // Every alias below was confirmed by ops on 2026-08-05 against the real
    // unresolved list, not guessed. Row counts are as of that confirmation.
    const knownAliasTargets = new Set([
      "ICDD",
      "PNLC",
      "SCTP",
      "SRR",
      "ITCM",
      "FCRL",
    ]);

    it("resolves TBAD to ICDD", () => { // 49
      expect(resolveDepartmentCode("TBAD", knownAliasTargets)).toBe("ICDD");
    });
    it("resolves PNTC to PNLC", () => { // 37
      expect(resolveDepartmentCode("PNTC", knownAliasTargets)).toBe("PNLC");
    });
    it("resolves SCTL to SCTP", () => { // 26
      expect(resolveDepartmentCode("SCTL", knownAliasTargets)).toBe("SCTP");
    });
    it("resolves ICCD to ICDD", () => { // 19
      expect(resolveDepartmentCode("ICCD", knownAliasTargets)).toBe("ICDD");
    });
    it("resolves LCCN to PNLC", () => { // 14
      expect(resolveDepartmentCode("LCCN", knownAliasTargets)).toBe("PNLC");
    });
    it("resolves SR&R to SRR", () => { // 8
      expect(resolveDepartmentCode("SR&R", knownAliasTargets)).toBe("SRR");
    });
    it("resolves ITCC to ITCM", () => { // 7
      expect(resolveDepartmentCode("ITCC", knownAliasTargets)).toBe("ITCM");
    });
    it("resolves FCLR to FCRL", () => { // 3
      expect(resolveDepartmentCode("FCLR", knownAliasTargets)).toBe("FCRL");
    });

    it("matches aliases case-insensitively", () => {
      expect(resolveDepartmentCode("tbad", knownAliasTargets)).toBe("ICDD");
    });

    it("returns null when an alias's target department is not in knownCodes", () => {
      expect(resolveDepartmentCode("TBAD", new Set(["BVHD"]))).toBeNull();
    });
  });
});

describe("resolveDepartmentCodes", () => {
  it("dedupes, preserves order, and reports the unmapped separately", () => {
    const out = resolveDepartmentCodes(["BVHD", "bvhd", "XXXX", null, "SCTP"], known);
    expect(out.codes).toEqual(["BVHD", "SCTP"]);
    expect(out.unmapped).toEqual(["XXXX"]);
  });
});
