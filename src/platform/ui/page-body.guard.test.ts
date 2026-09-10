import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The cycle workspace is one set of tabs over one cycle, so the content column
 * should not resize when you click between them. Before `PageBody` it did: the
 * sixteen pages under `cycles/[id]` ran 42rem, 48rem, 56rem, 72rem and
 * full-bleed, each width a `max-w-*` typed into a wrapper div by whoever wrote
 * that tab.
 *
 * A grep guard rather than a lint rule because the thing being guarded is a
 * property of the DIRECTORY -- every page in it declares a width by name -- and
 * a rule that fires per-file cannot see whether the sixteenth tab exists.
 */
const WORKSPACE = "src/app/(app)/recruitment/cycles/[id]";

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pageFiles(path);
    return entry.name === "page.tsx" ? [path] : [];
  });
}

function hits(pattern: string): string[] {
  try {
    return execSync(
      `grep -rn --include='page.tsx' -F ${JSON.stringify(pattern)} ${JSON.stringify(WORKSPACE)}`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    return []; // grep exits 1 on no matches
  }
}

describe("cycle workspace frame widths", () => {
  it("has every tab declaring its width through PageBody", () => {
    // The rhythm is only kept if a NEW tab has to name a width too. A page that
    // opens with a bare wrapper div inherits whatever measure its author liked.
    const declared = new Set(hits("<PageBody").map((line) => line.split(":")[0]));
    const missing = pageFiles(WORKSPACE).filter((path) => !declared.has(path));
    expect(missing).toEqual([]);
  });

  it("has no tab hand-rolling a max-width frame", () => {
    // `max-w-*` on a <p> is a prose measure and stays -- interviews/page.tsx
    // sets one on its lede. This fences the frame: a wrapper div holding the
    // page. Those are `PageBody`'s four named measures now.
    expect(hits('<div className="max-w-')).toEqual([]);
    expect(hits('<div className="mx-auto max-w-')).toEqual([]);
  });
});
