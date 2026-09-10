import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * /admin/settings renders one Save per setting, and the registry defines roughly
 * 65 of them -- 35 explicit `define(...)` calls plus one per notification
 * channel. Every one carried `variant="primary"`, so the page stacked ~65
 * identical brand-filled calls to action and a brand fill stopped meaning
 * anything.
 *
 * FilterBar's doc comment already wrote the rule down for its own Filter button:
 * a repeated, non-leading control is not a page's primary action.
 *
 * Asserted POSITIVELY as well as negatively. Button's default variant IS
 * primary (button.tsx:44), so a future `<Button type="submit" size="sm">Save`
 * with the prop simply deleted would re-inflate the page while a
 * count-of-"primary"-is-zero guard still passed.
 */
const PAGE = "src/app/(app)/admin/settings/page.tsx";

describe("the /admin/settings action emphasis", () => {
  it("gives the repeated Save an explicit non-primary variant", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toContain('<Button type="submit" variant="outline" size="sm">Save</Button>');
  });

  it("has no brand-filled button on the page at all", () => {
    expect(readFileSync(PAGE, "utf8")).not.toContain('variant="primary"');
  });

  it("keeps Reset quieter than Save, now that Save is quiet too", () => {
    // Two outline siblings inside one card read as a pair of equals, and
    // resetting is the rarer and more destructive of the two.
    expect(readFileSync(PAGE, "utf8")).toContain(
      '<Button type="submit" variant="ghost" size="sm">Reset to default</Button>',
    );
  });
});
