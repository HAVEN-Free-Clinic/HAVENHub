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
function hits(pattern: string, fixed = true): string[] {
  const mode = fixed ? "-F" : "-E";
  try {
    return execSync(`grep -rn --include='*.tsx' ${mode} ${JSON.stringify(pattern)} src`, {
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
    //
    // The vertical padding is a pattern, not a literal. The first pass fenced
    // `py-10` exactly, and a fourteenth site
    // (src/modules/support/components/comment-thread.tsx, the ticket
    // conversation's "No replies yet.") sat one step down the scale at `py-8`
    // and stayed green: same recipe, same drift, invisible to the fence. Any
    // padless Card whose className opens with a centered horizontal-plus-
    // vertical inset is the recipe, whichever numbers it uses.
    expect(hits('pad=\\{false\\} className="px-[0-9]+ py-[0-9]+ text-center', false)).toEqual([]);
  });
});
