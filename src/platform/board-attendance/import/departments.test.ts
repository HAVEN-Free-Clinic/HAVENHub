import { describe, expect, it } from "vitest";
import { DEPARTMENTS } from "../../../../prisma/department-catalog";
import { resolveBoardDepartmentCode } from "./departments";

const known = new Set(DEPARTMENTS.map((d) => d.code));

/** Every distinct department label the four attendance grids actually write. */
const SHEET_LABELS = [
  "Behavioral Health Department",
  "Behavioral Health",
  "Clinical Advisor",
  "Community Relations & Advocacy",
  "Community Relations and Advocacy",
  "Education",
  "Executive Director",
  "Faculty Relations",
  "Finance and Development",
  "Food Pharmacy",
  "ICDD",
  "IT & Communications",
  "Interpretation & Diversity",
  "LCC",
  "LTBI",
  "Lab",
  "Medical Debt & Insurance Counseling",
  "Medical Legal Partnership",
  "Medical-Legal Partnership",
  "Oral Health Initiative",
  "Oral Health",
  "Patient Services",
  "Pharmacy",
  "Public Relations",
  "QA/QI",
  "Referrals",
  "Reproductive Health Department",
  "Reproductive Health",
  "Social Services",
  "Student Recruitment",
  "Vaccine",
];

describe("resolveBoardDepartmentCode", () => {
  it("maps every label the workbook writes", () => {
    for (const label of SHEET_LABELS) {
      expect(resolveBoardDepartmentCode(label, known), label).not.toBeNull();
    }
  });

  it("tolerates the trailing space the sheet leaves on some labels", () => {
    expect(resolveBoardDepartmentCode("Patient Services ", known)).toBe("PATS");
  });

  it("reads the two spellings of one department as one department", () => {
    expect(resolveBoardDepartmentCode("Medical Legal Partnership", known)).toBe(
      resolveBoardDepartmentCode("Medical-Legal Partnership", known),
    );
    expect(resolveBoardDepartmentCode("Community Relations & Advocacy", known)).toBe(
      resolveBoardDepartmentCode("Community Relations and Advocacy", known),
    );
  });

  it("follows the renames the hub has since made", () => {
    expect(resolveBoardDepartmentCode("Pharmacy", known)).toBe("MEDS");
    expect(resolveBoardDepartmentCode("Lab", known)).toBe("PHLO");
    expect(resolveBoardDepartmentCode("LCC", known)).toBe("PNLC");
    // The 2026 grid renames the 2025 grid's LTBI rows to ICDD with the same
    // directors under them, which is what licenses this one.
    expect(resolveBoardDepartmentCode("LTBI", known)).toBe("ICDD");
  });

  it("returns null rather than guessing at an unknown label", () => {
    expect(resolveBoardDepartmentCode("Ophthalmology", known)).toBeNull();
    expect(resolveBoardDepartmentCode("", known)).toBeNull();
    expect(resolveBoardDepartmentCode(null, known)).toBeNull();
  });

  it("returns null when the mapped department no longer exists", () => {
    expect(resolveBoardDepartmentCode("Pharmacy", new Set(["EDUC"]))).toBeNull();
  });
});
