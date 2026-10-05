import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("floating surfaces", () => {
  const css = read("src/app/globals.css");

  it("defines the .float-bar and .float-panel classes", () => {
    expect(css).toMatch(/\.float-bar\b/);
    expect(css).toMatch(/\.float-panel\b/);
  });

  it("is solid: no backdrop-filter, so fixed descendants are never trapped (#304)", () => {
    expect(css).not.toMatch(/backdrop-filter\s*:/);
    expect(css).not.toMatch(/\.glass-(bar|panel)/);
  });

  it("pops panels in only when the user has not asked for reduced motion", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.float-panel\s*\{\s*animation: var\(--animate-pop-in\)/,
    );
  });

  it("renders the app-shell header as a floating pill", () => {
    const shell = read("src/platform/ui/app-shell.tsx");
    expect(shell).toContain("float-bar");
    expect(shell).toContain("rounded-full");
  });

  it("uses .float-panel and the shared scrim for the modal", () => {
    const modal = read("src/platform/ui/modal.tsx");
    expect(modal).toContain("float-panel");
    expect(modal).toContain("bg-scrim");
  });

  it("uses .float-panel for the combobox popover", () => {
    expect(read("src/platform/ui/combobox.tsx")).toContain("float-panel");
  });

  it("does NOT float the breadcrumbs or module tabs (no stacked chrome)", () => {
    expect(read("src/platform/ui/breadcrumbs.tsx")).not.toMatch(/float-(bar|panel)/);
    expect(read("src/platform/ui/module-nav.tsx")).not.toMatch(/float-(bar|panel)/);
  });
});
