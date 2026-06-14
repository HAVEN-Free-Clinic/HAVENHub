import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("liquid glass material", () => {
  const css = read("src/app/globals.css");

  it("defines the .glass-bar and .glass-panel utility classes", () => {
    expect(css).toMatch(/\.glass-bar\b/);
    expect(css).toMatch(/\.glass-panel\b/);
  });

  it("uses backdrop-filter for the material", () => {
    expect(css).toMatch(/backdrop-filter:\s*blur/);
  });

  it("provides a solid fallback when transparency/contrast is reduced", () => {
    expect(css).toMatch(/prefers-reduced-transparency/);
    expect(css).toMatch(/prefers-contrast/);
    expect(css).toMatch(/forced-colors/);
  });

  it("adapts the material for dark mode", () => {
    expect(css).toMatch(/html\.dark\s+\.glass-(bar|panel)/);
  });

  it("renders the app-shell header as a floating glass pill", () => {
    const shell = read("src/platform/ui/app-shell.tsx");
    expect(shell).toContain("glass-bar");
    expect(shell).toContain("rounded-full"); // pill shape on the floating bar
    // The old ad-hoc frosted recipe should be gone.
    expect(shell).not.toContain("bg-surface/85");
    // The old edge-to-edge brand accent line is removed in the floating design.
    expect(shell).not.toContain("h-0.5 bg-brand");
  });

  it("uses .glass-panel for the modal and blurs its scrim", () => {
    const modal = read("src/platform/ui/modal.tsx");
    expect(modal).toContain("glass-panel");
    expect(modal).toContain("backdrop-blur-sm");
  });

  it("uses .glass-panel for the combobox popover", () => {
    expect(read("src/platform/ui/combobox.tsx")).toContain("glass-panel");
  });

  it("does NOT glass the breadcrumbs or module tabs (Apple: no layering glass)", () => {
    expect(read("src/platform/ui/breadcrumbs.tsx")).not.toMatch(/glass-(bar|panel)/);
    expect(read("src/platform/ui/module-nav.tsx")).not.toMatch(/glass-(bar|panel)/);
  });
});
