import { describe, expect, it } from "vitest";
import { isSectionVisible, visibleSections, applicantTypeLabel, type SectionVisibilityInput } from "./visibility";

const S = (over: Partial<SectionVisibilityInput>): SectionVisibilityInput => ({
  id: "s",
  appliesTo: "BOTH",
  departmentCode: null,
  ...over,
});

describe("isSectionVisible", () => {
  it("BOTH + no department is always visible", () => {
    expect(isSectionVisible(S({}), { applicantType: "NEW", selectedDepartmentCodes: [] })).toBe(true);
    expect(isSectionVisible(S({}), { applicantType: "RENEWAL", selectedDepartmentCodes: [] })).toBe(true);
  });
  it("NEW-only section hides from renewals", () => {
    expect(isSectionVisible(S({ appliesTo: "NEW" }), { applicantType: "RENEWAL", selectedDepartmentCodes: [] })).toBe(false);
    expect(isSectionVisible(S({ appliesTo: "NEW" }), { applicantType: "NEW", selectedDepartmentCodes: [] })).toBe(true);
  });
  it("department supplement shows only when its code is chosen", () => {
    const sec = S({ departmentCode: "SRHD" });
    expect(isSectionVisible(sec, { applicantType: "NEW", selectedDepartmentCodes: ["SRHD"] })).toBe(true);
    expect(isSectionVisible(sec, { applicantType: "NEW", selectedDepartmentCodes: ["MDIC"] })).toBe(false);
  });
  it("department supplement also respects appliesTo", () => {
    const sec = S({ departmentCode: "SRHD", appliesTo: "RENEWAL" });
    expect(isSectionVisible(sec, { applicantType: "NEW", selectedDepartmentCodes: ["SRHD"] })).toBe(false);
    expect(isSectionVisible(sec, { applicantType: "RENEWAL", selectedDepartmentCodes: ["SRHD"] })).toBe(true);
  });
  it("TRANSFER sees NEW sections and BOTH, but not RENEWAL-only", () => {
    expect(isSectionVisible(S({ appliesTo: "NEW" }), { applicantType: "TRANSFER", selectedDepartmentCodes: [] })).toBe(true);
    expect(isSectionVisible(S({}), { applicantType: "TRANSFER", selectedDepartmentCodes: [] })).toBe(true);
    expect(isSectionVisible(S({ appliesTo: "RENEWAL" }), { applicantType: "TRANSFER", selectedDepartmentCodes: [] })).toBe(false);
  });
});

describe("visibleSections", () => {
  it("filters a list", () => {
    const sections = [S({ id: "a" }), S({ id: "b", appliesTo: "NEW" }), S({ id: "c", departmentCode: "MDIC" })];
    const out = visibleSections(sections, { applicantType: "RENEWAL", selectedDepartmentCodes: ["MDIC"] });
    expect(out.map((s) => s.id)).toEqual(["a", "c"]);
  });
});

describe("applicantTypeLabel", () => {
  it("labels each applicant type", () => {
    expect(applicantTypeLabel("NEW")).toBe("New");
    expect(applicantTypeLabel("RENEWAL")).toBe("Renewal");
    expect(applicantTypeLabel("TRANSFER")).toBe("Transfer");
  });
});
