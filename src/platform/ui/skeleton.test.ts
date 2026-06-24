import { describe, expect, it } from "vitest";
import { Skeleton } from "./skeleton";

describe("Skeleton", () => {
  it("is decorative (aria-hidden)", () => {
    const el = Skeleton({});
    expect(el.props["aria-hidden"]).toBe(true);
  });

  it("animates with a pulse and honors reduced motion", () => {
    const el = Skeleton({});
    expect(el.props.className).toContain("animate-pulse");
    expect(el.props.className).toContain("motion-reduce:animate-none");
  });

  it("merges caller classes for size and shape", () => {
    const el = Skeleton({ className: "h-9 w-72 rounded-2xl" });
    expect(el.props.className).toContain("h-9 w-72 rounded-2xl");
  });
});
