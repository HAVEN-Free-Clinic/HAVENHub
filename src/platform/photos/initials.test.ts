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
    expect(initialsSvg("<script> Bad")).not.toContain("<script>");
  });
});
