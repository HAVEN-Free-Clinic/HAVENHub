import { describe, it, expect } from "vitest";
import { modalSizeClass } from "./modal-size";

describe("modalSizeClass", () => {
  it("defaults to max-w-4xl", () => {
    expect(modalSizeClass()).toBe("max-w-4xl");
    expect(modalSizeClass("default")).toBe("max-w-4xl");
  });
  it("uses a wider panel for large", () => {
    expect(modalSizeClass("large")).toBe("max-w-6xl");
  });
});
