import { describe, expect, it } from "vitest";
import { TopProgressBar } from "./top-progress-bar";

describe("TopProgressBar", () => {
  it("renders without throwing", () => {
    expect(() => TopProgressBar()).not.toThrow();
    expect(TopProgressBar()).toBeTruthy();
  });

  it("paints the bar in the brand color", () => {
    const el = TopProgressBar();
    expect(el.props.color).toBe("var(--color-brand)");
  });
});
