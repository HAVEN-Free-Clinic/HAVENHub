import { describe, expect, it } from "vitest";
import { CONTRIBUTORS, copyrightHolder, formatCopyright } from "./attribution";

describe("copyrightHolder", () => {
  it("appends the IT Department to the organization name", () => {
    expect(copyrightHolder("HAVEN Free Clinic")).toBe("HAVEN Free Clinic IT Department");
  });

  it("follows a rebranded organization name", () => {
    expect(copyrightHolder("Open Door Clinic")).toBe("Open Door Clinic IT Department");
  });

  it("trims a padded organization name so the line never double-spaces", () => {
    expect(copyrightHolder("  HAVEN Free Clinic  ")).toBe("HAVEN Free Clinic IT Department");
  });
});

describe("formatCopyright", () => {
  it("renders the full notice for a given year", () => {
    expect(formatCopyright("HAVEN Free Clinic", 2026)).toBe(
      "© Copyright 2026 HAVEN Free Clinic IT Department"
    );
  });

  it("takes the year from the caller so the line rolls forward", () => {
    expect(formatCopyright("HAVEN Free Clinic", 2027)).toBe(
      "© Copyright 2027 HAVEN Free Clinic IT Department"
    );
  });
});

describe("CONTRIBUTORS", () => {
  it("credits the three ITCM directors", () => {
    expect(CONTRIBUTORS.map((c) => c.name)).toEqual([
      "Jack Carney",
      "Caprice Culkin",
      "Renée Tracey",
    ]);
  });

  it("gives every contributor a role and a contact address", () => {
    for (const contributor of CONTRIBUTORS) {
      expect(contributor.role).not.toBe("");
      expect(contributor.email).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    }
  });
});
