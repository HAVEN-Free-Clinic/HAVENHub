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
  it("credits the ITCM directors and the executive director who backed the build", () => {
    expect(CONTRIBUTORS.map((c) => c.name)).toEqual([
      "Jack Carney",
      "Caprice Culkin",
      "Renée Tracey",
      "Antigone Antonakakis",
    ]);
  });

  it("gives every contributor a role", () => {
    for (const contributor of CONTRIBUTORS) {
      expect(contributor.role).not.toBe("");
    }
  });

  it("lists a well-formed address wherever a contributor has one", () => {
    for (const contributor of CONTRIBUTORS) {
      if (contributor.email === undefined) continue;
      expect(contributor.email).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    }
  });

  it("still carries a contact address for every serving ITCM director", () => {
    const serving = CONTRIBUTORS.filter((c) => c.role === "Director of IT and Communications");
    expect(serving).toHaveLength(3);
    for (const director of serving) {
      expect(director.email).toBeDefined();
    }
  });
});
