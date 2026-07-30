import { describe, expect, it } from "vitest";
import {
  YALE_AFFILIATIONS,
  affiliationLabel,
  affiliationOptionsWith,
  isMedicalSchoolAffiliation,
  isStudentAffiliation,
  normalizeAffiliation,
} from "./affiliation";

describe("YALE_AFFILIATIONS", () => {
  it("holds the 13 canonical options with unique values", () => {
    expect(YALE_AFFILIATIONS).toHaveLength(13);
    expect(new Set(YALE_AFFILIATIONS.map((o) => o.value)).size).toBe(13);
  });
});

describe("affiliationLabel", () => {
  it("resolves a canonical key to its user-facing label", () => {
    expect(affiliationLabel("ysm_md")).toBe("Yale School of Medicine (YSM), MD or MD/PhD");
    expect(affiliationLabel("staff")).toBe("Yale Staff");
  });

  it("passes an unrecognized value through unchanged rather than blanking it", () => {
    expect(affiliationLabel("Medical Student")).toBe("Medical Student");
  });

  it("returns the empty string for null, undefined, and blank", () => {
    expect(affiliationLabel(null)).toBe("");
    expect(affiliationLabel(undefined)).toBe("");
    expect(affiliationLabel("   ")).toBe("");
  });
});

describe("affiliationOptionsWith", () => {
  it("returns exactly the canonical list for a canonical value", () => {
    expect(affiliationOptionsWith("ysn")).toHaveLength(13);
  });

  it("returns exactly the canonical list for null or blank", () => {
    expect(affiliationOptionsWith(null)).toHaveLength(13);
    expect(affiliationOptionsWith("")).toHaveLength(13);
  });

  it("prepends an unrecognized stored value exactly once so re-saving cannot erase it", () => {
    const options = affiliationOptionsWith("Medical Student");
    expect(options).toHaveLength(14);
    expect(options[0]).toEqual({ value: "Medical Student", label: "Medical Student" });
  });
});

describe("normalizeAffiliation", () => {
  it("maps every option from the retired /my-info dropdown", () => {
    expect(normalizeAffiliation("Yale College")).toBe("yale_college");
    expect(normalizeAffiliation("Yale School of Medicine")).toBe("ysm_md");
    expect(normalizeAffiliation("Yale School of Nursing")).toBe("ysn");
    expect(normalizeAffiliation("Yale School of Public Health")).toBe("ysph");
    expect(normalizeAffiliation("Physician Associate Program")).toBe("ysm_pa");
    expect(normalizeAffiliation("Graduate School")).toBe("gsas");
    expect(normalizeAffiliation("Staff")).toBe("staff");
    expect(normalizeAffiliation("Other")).toBe("other_yale");
  });

  it("maps the canonical labels that Airtable stores", () => {
    expect(normalizeAffiliation("Yale Staff")).toBe("staff");
    expect(normalizeAffiliation("Other Yale Affiliation")).toBe("other_yale");
    expect(normalizeAffiliation("Yale Law School (YLS)")).toBe("law");
    expect(normalizeAffiliation("Yale School of Medicine (YSM), PA")).toBe("ysm_pa");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeAffiliation("  yale STAFF  ")).toBe("staff");
    expect(normalizeAffiliation("graduate school")).toBe("gsas");
  });

  it("leaves an already-canonical key untouched", () => {
    for (const option of YALE_AFFILIATIONS) {
      expect(normalizeAffiliation(option.value)).toBe(option.value);
    }
  });

  it("returns an unmapped string trimmed but otherwise unchanged", () => {
    expect(normalizeAffiliation("  Medical Student ")).toBe("Medical Student");
  });

  it("returns null for null, undefined, and whitespace-only input", () => {
    expect(normalizeAffiliation(null)).toBeNull();
    expect(normalizeAffiliation(undefined)).toBeNull();
    expect(normalizeAffiliation("   ")).toBeNull();
  });
});

describe("isStudentAffiliation", () => {
  it("returns true for every named Yale school", () => {
    for (const value of ["yale_college", "divinity", "gsas", "jackson", "law", "som", "ysm_md", "ysm_pa", "ysn", "ysph"]) {
      expect(isStudentAffiliation(value)).toBe(true);
    }
  });

  it("returns false for staff, other, and not-a-Yale-affiliate", () => {
    for (const value of ["staff", "other_yale", "non_yale"]) {
      expect(isStudentAffiliation(value)).toBe(false);
    }
  });

  it("returns false for the legacy non-student strings the backfill may not map", () => {
    for (const value of ["Yale Staff", "Staff", "Other Yale Affiliation", "Other", "I am NOT a Yale Affiliate"]) {
      expect(isStudentAffiliation(value)).toBe(false);
    }
  });

  it("returns false for blank, null, and undefined", () => {
    expect(isStudentAffiliation(null)).toBe(false);
    expect(isStudentAffiliation(undefined)).toBe(false);
    expect(isStudentAffiliation("")).toBe(false);
  });

  it("returns true for an unrecognized school-like value rather than assuming staff", () => {
    expect(isStudentAffiliation("Medical Student")).toBe(true);
  });
});

describe("isMedicalSchoolAffiliation", () => {
  it("is true for exactly the two YSM tracks", () => {
    expect(isMedicalSchoolAffiliation("ysm_md")).toBe(true);
    expect(isMedicalSchoolAffiliation("ysm_pa")).toBe(true);
  });

  it("is false for every other canonical option", () => {
    for (const option of YALE_AFFILIATIONS) {
      if (option.value === "ysm_md" || option.value === "ysm_pa") continue;
      expect(isMedicalSchoolAffiliation(option.value)).toBe(false);
    }
  });

  it("is false for null and blank", () => {
    expect(isMedicalSchoolAffiliation(null)).toBe(false);
    expect(isMedicalSchoolAffiliation("")).toBe(false);
  });
});
