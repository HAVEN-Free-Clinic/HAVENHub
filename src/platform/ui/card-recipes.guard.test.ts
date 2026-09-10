import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

/**
 * Two hand-rolled Card recipes, both of which the primitive now owns.
 *
 * A grep guard rather than a lint rule, deliberately. The obvious rule to write
 * here -- extend `local/no-adhoc-empty-state` to fire on a centered muted Card
 * -- can only see 4 of the 13 empty-card shapes: it reads DIRECT JSXText, so it
 * is blind to the two sites holding a ternary, to the local EmptyCard helper
 * whose only child is `{children}`, and to the one whose sentence starts
 * "Everyone" rather than "No/Nothing/None/Nobody". A guard that catches nine of
 * thirteen and reports clean invites more confidence than it earns. This fences
 * the exact string, all thirteen of them.
 */
function hits(pattern: string): string[] {
  try {
    return execSync(`grep -rn --include='*.tsx' -F ${JSON.stringify(pattern)} src`, {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      // card.tsx's own doc comment quotes the retired recipe to say what it
      // replaced, which is the one place the string SHOULD still appear.
      .filter((line) => !line.startsWith("src/platform/ui/card.tsx:"));
  } catch {
    return []; // grep exits 1 on no matches
  }
}

describe("hand-rolled Card recipes", () => {
  it("has no panel spelling out the tight inset", () => {
    // Six schedule panels wrote `cardClasses({ pad: false })} px-4 py-3`. It is
    // `pad: "tight"` now.
    expect(hits('cardClasses({ pad: false })} px-4 py-3')).toEqual([]);
    expect(hits('cardClasses({ pad: false }) + " px-4 py-3"')).toEqual([]);
  });

  it("has no Card hand-drawing an empty state", () => {
    // Thirteen sites rendered a sentence as centered muted text inside a
    // padless Card, so "no rows" read as a stray line rather than as the empty
    // state every other list in the app shows.
    expect(hits('pad={false} className="px-6 py-10 text-center')).toEqual([]);
  });
});
