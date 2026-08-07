import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { resolveBuilderView, builderViewHref } = await import("./builder-toolbar");

describe("resolveBuilderView", () => {
  it("selects Day when neither param is present", () => {
    expect(resolveBuilderView(undefined, undefined)).toBe("day");
  });

  it("selects Grid for view=grid", () => {
    expect(resolveBuilderView("grid", undefined)).toBe("grid");
  });

  it("selects Availability for mode=availability", () => {
    expect(resolveBuilderView(undefined, "availability")).toBe("availability");
  });

  // Preserves today's behaviour: the availability editor shows "over either
  // view", so an existing bookmark carrying both params must still resolve to
  // Availability rather than Grid.
  it("lets mode=availability win over view=grid, so old deep links still resolve", () => {
    expect(resolveBuilderView("grid", "availability")).toBe("availability");
  });

  it("ignores an unrecognised view value and falls back to Day", () => {
    expect(resolveBuilderView("banana", undefined)).toBe("day");
  });
});

describe("builderViewHref", () => {
  const base = { dept: "d1", date: "2026-09-20", term: "t1" };

  it("emits neither view nor mode for Day", () => {
    const href = builderViewHref("/schedule/builder", base, "day");
    expect(href).not.toContain("view=");
    expect(href).not.toContain("mode=");
    expect(href).toContain("dept=d1");
  });

  it("emits only view=grid for Grid", () => {
    const href = builderViewHref("/schedule/builder", base, "grid");
    expect(href).toContain("view=grid");
    expect(href).not.toContain("mode=");
  });

  it("emits only mode=availability for Availability", () => {
    const href = builderViewHref("/schedule/builder", base, "availability");
    expect(href).toContain("mode=availability");
    expect(href).not.toContain("view=");
  });

  it("carries the selected department, date, and term through every view change", () => {
    for (const view of ["day", "grid", "availability"] as const) {
      const href = builderViewHref("/schedule/builder", base, view);
      expect(href).toContain("dept=d1");
      expect(href).toContain("term=t1");
    }
  });
});
