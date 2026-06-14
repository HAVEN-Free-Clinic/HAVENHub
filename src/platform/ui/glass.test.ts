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

  it("applies .glass-bar to the sticky app-shell header", () => {
    const shell = read("src/platform/ui/app-shell.tsx");
    expect(shell).toMatch(/<header[^>]*className="[^"]*\bglass-bar\b/);
    // The old ad-hoc frosted recipe should be gone.
    expect(shell).not.toContain("bg-surface/85");
  });
});
