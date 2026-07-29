import { describe, it, expect } from "vitest";
import { departmentChoiceOptions, resolveSectionTitle } from "./department-options";
import { defaultSupplementSectionTitle } from "./application/supplements/dept-codes";
import { volunteerSupplementSections } from "./application/volunteer";
import { directorSupplementSections } from "./application/director";

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

describe("resolveSectionTitle", () => {
  const departments = [{ code: "MDIC", name: "Medical Debt and Insurance Counseling" }];

  it("swaps in the department name when the stored title is the generated default", () => {
    const title = resolveSectionTitle({ title: defaultSupplementSectionTitle("MDIC"), departmentCode: "MDIC" }, departments);
    expect(title).toBe("Medical Debt and Insurance Counseling department questions");
  });

  it("leaves a director-customized title exactly as stored", () => {
    const customized = "Tell us about your interest in Medical Debt & Insurance Counseling";
    const title = resolveSectionTitle({ title: customized, departmentCode: "MDIC" }, departments);
    expect(title).toBe(customized);
  });

  it("keeps the stored title when the departmentCode has no matching Department row", () => {
    const stored = defaultSupplementSectionTitle("ZZZZ");
    const title = resolveSectionTitle({ title: stored, departmentCode: "ZZZZ" }, departments);
    expect(title).toBe(stored);
  });

  it("leaves a section with no departmentCode (a shared, non-supplement section) untouched", () => {
    const title = resolveSectionTitle({ title: "Personal details", departmentCode: null }, departments);
    expect(title).toBe("Personal details");
  });

  // The main risk this task's brief calls out: the generator (volunteer.ts /
  // director.ts) and this matcher independently deciding what "the generated
  // default" looks like, and drifting apart so the substitution silently stops
  // firing. Both sides import defaultSupplementSectionTitle rather than
  // re-typing the template literal, so this test exercises the real generator
  // output end to end rather than a hand-written stand-in for it -- if either
  // side stops using the shared function, the first assertion in this test
  // fails.
  it("agrees with the real generator output for both tracks", () => {
    const [volunteerSection] = volunteerSupplementSections(["MDIC"]);
    const [directorSection] = directorSupplementSections(["MDIC"]);
    for (const section of [volunteerSection, directorSection]) {
      expect(section.title).toBe(defaultSupplementSectionTitle(section.departmentCode!));
      expect(resolveSectionTitle(section, departments)).toBe("Medical Debt and Insurance Counseling department questions");
    }
  });
});
