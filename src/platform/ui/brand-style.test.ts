import { describe, expect, it } from "vitest";
import { brandStyleVars } from "./brand-style";

describe("brandStyleVars", () => {
  it("sets --color-brand to the given hex", () => {
    expect(brandStyleVars("#00356b")).toContain("--color-brand:#00356b;");
  });

  it("derives the four shade variants with color-mix", () => {
    const css = brandStyleVars("#123456");
    expect(css).toContain("--color-brand-hover:color-mix(in srgb, #123456 88%, black);");
    expect(css).toContain("--color-brand-deep:color-mix(in srgb, #123456 75%, black);");
    expect(css).toContain("--color-brand-light:color-mix(in srgb, #123456 18%, white);");
    expect(css).toContain("--color-brand-faint:color-mix(in srgb, #123456 6%, white);");
  });

  it("wraps the declarations in a :root rule", () => {
    expect(brandStyleVars("#000000").startsWith(":root{")).toBe(true);
    expect(brandStyleVars("#000000").endsWith("}")).toBe(true);
  });
});
