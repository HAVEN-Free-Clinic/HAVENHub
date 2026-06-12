import { describe, expect, it } from "vitest";
import { Spinner } from "./spinner";

describe("Spinner", () => {
  it("is decorative (aria-hidden) and always spins, respecting reduced motion", () => {
    const el = Spinner({});
    expect(el.props["aria-hidden"]).toBe(true);
    expect(el.props.className).toContain("animate-spin");
    expect(el.props.className).toContain("motion-reduce:animate-none");
  });

  it("defaults to the medium size", () => {
    const el = Spinner({});
    expect(el.props.className).toContain("h-5");
    expect(el.props.className).toContain("w-5");
  });

  it("applies the requested size", () => {
    expect(Spinner({ size: "sm" }).props.className).toContain("h-4");
    expect(Spinner({ size: "lg" }).props.className).toContain("h-6");
  });

  it("merges a caller-provided className", () => {
    const el = Spinner({ className: "text-brand" });
    expect(el.props.className).toContain("text-brand");
  });
});
