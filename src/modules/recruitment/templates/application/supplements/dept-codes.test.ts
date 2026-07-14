import { describe, it, expect } from "vitest";
import { normalizeDeptCode, SUPPLEMENT_DEPARTMENTS } from "./dept-codes";

// Repo Department seed codes (source of truth) after Task 7 additions.
const SEED_CODES = new Set([
  "BVHD","CCRH","CRAD","EDUC","EXEC","FCRL","FIND","FOOD","ICDD","INTP","ITCM","JCTP","JCTS","JONES","LABR","LCCN","MDIC","MDLP","ORHI","PATS","PBRL","PCAR","PHAM","PNLC","PNTC","QAQI","REFF","SCTL","SCTP","SCTS","SOSE","SRHD","SRR","TBAD","VADC","VADM",
]);

describe("dept-codes", () => {
  it("normalizes Airtable aliases to seed codes", () => {
    expect(normalizeDeptCode("FCLR")).toBe("FCRL");
    expect(normalizeDeptCode("SR&R")).toBe("SRR");
    expect(normalizeDeptCode(" mdic ")).toBe("MDIC");
  });
  it("every supplement department resolves to a seeded Department code", () => {
    for (const track of ["VOLUNTEER", "DIRECTOR"] as const) {
      for (const code of SUPPLEMENT_DEPARTMENTS[track]) expect(SEED_CODES.has(code)).toBe(true);
    }
  });
});
