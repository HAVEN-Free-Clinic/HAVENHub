import { describe, expect, it } from "vitest";
import { initialsSvg, toInitials } from "./initials";

describe("toInitials", () => {
  it("takes the first and last name initials", () => {
    expect(toInitials("Ada Lovelace")).toBe("AL");
  });

  it("handles a single name", () => {
    expect(toInitials("Ada")).toBe("A");
  });

  it("skips middle names", () => {
    expect(toInitials("Ada Byron King Lovelace")).toBe("AL");
  });

  it("returns the middle-dot placeholder for null", () => {
    expect(toInitials(null)).toBe("·");
  });

  it("returns the middle-dot placeholder for an empty or whitespace name", () => {
    expect(toInitials("   ")).toBe("·");
  });
});

// Given the stored parts, the surname is known rather than guessed at. The
// avatar sits next to the DISPLAY name, so the first initial follows the
// preferred name while the second follows the real surname.
describe("toInitials, from the stored name parts", () => {
  it("uses the preferred first name, because that is the name on screen", () => {
    expect(
      toInitials({ legalFirstName: "Margaret", lastName: "Bia", preferredFirstName: "Peggy" }),
    ).toBe("PB");
  });

  it("initials a compound surname on its first word", () => {
    expect(toInitials({ legalFirstName: "Javier", lastName: "Ponce Terashima" })).toBe("JP");
  });

  it("gives a mononym one letter", () => {
    expect(toInitials({ legalFirstName: "Cher", lastName: "" })).toBe("C");
  });

  it("falls back to the placeholder when both parts are blank", () => {
    expect(toInitials({ legalFirstName: "", lastName: "" })).toBe("·");
  });
});

describe("initialsSvg", () => {
  it("renders the initials into the SVG", () => {
    expect(initialsSvg("Ada Lovelace")).toContain(">AL<");
  });

  it("is a well-formed standalone SVG", () => {
    const svg = initialsSvg("Ada Lovelace");

    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("gives different names different backgrounds", () => {
    expect(initialsSvg("Ada Lovelace")).not.toBe(initialsSvg("Grace Hopper"));
  });

  it("gives the same name the same background every time", () => {
    expect(initialsSvg("Ada Lovelace")).toBe(initialsSvg("Ada Lovelace"));
  });

  it("escapes characters that would break the markup", () => {
    const svg = initialsSvg("<script> Bad");
    expect(svg).toContain("&lt;B");
    expect(svg).not.toContain("<B");
  });

  it("reads the initials from the parts when it is given them", () => {
    const name = "Javier Ponce Terashima";

    expect(initialsSvg(name)).toContain(">JT<");
    expect(
      initialsSvg(name, { legalFirstName: "Javier", lastName: "Ponce Terashima" }),
    ).toContain(">JP<");
  });

  // The hue is keyed on the display name alone, so adding the parts does not
  // repaint every existing avatar a new colour.
  it("keeps the background the display name already had", () => {
    const hue = (svg: string) => svg.match(/hsl\((\d+)/)?.[1];
    const parts = { legalFirstName: "Ada", lastName: "Lovelace" };

    expect(hue(initialsSvg("Ada Lovelace", parts))).toBe(hue(initialsSvg("Ada Lovelace")));
  });
});
