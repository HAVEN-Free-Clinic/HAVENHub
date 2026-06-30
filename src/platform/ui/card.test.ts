import { describe, expect, it } from "vitest";
import { Card, cardClasses } from "./card";

describe("cardClasses", () => {
  it("defaults to the rounded-2xl content card with shadow and p-5", () => {
    const c = cardClasses();
    expect(c).toContain("rounded-2xl");
    expect(c).toContain("shadow-sm");
    expect(c).toContain("border-border");
    expect(c).toContain("bg-surface");
    expect(c).toContain("p-5");
  });

  it("compact is rounded-xl with p-3 and no base shadow", () => {
    const c = cardClasses({ size: "compact" });
    expect(c).toContain("rounded-xl");
    expect(c).toContain("p-3");
    expect(c).not.toContain("shadow-sm");
    expect(c).not.toContain("rounded-2xl");
  });

  it("omits the inset when pad is false", () => {
    expect(cardClasses({ pad: false })).not.toContain("p-5");
    expect(cardClasses({ size: "compact", pad: false })).not.toContain("p-3");
  });

  it("adds the hover-lift when interactive", () => {
    expect(cardClasses({ interactive: true })).toContain("hover:-translate-y-0.5");
  });
});

describe("Card", () => {
  it("renders a div with the default card classes", () => {
    const el = Card({});
    expect(el.type).toBe("div");
    expect(el.props.className).toContain("rounded-2xl");
  });

  it("applies the compact size and merges a caller className", () => {
    const el = Card({ size: "compact", className: "px-4 py-3" });
    expect(el.props.className).toContain("rounded-xl");
    expect(el.props.className).toContain("px-4 py-3");
  });
});
