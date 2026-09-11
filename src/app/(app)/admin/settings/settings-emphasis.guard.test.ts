import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * /admin/settings once rendered one Save per setting, about 65 of them, and
 * every one carried `variant="primary"`: the page stacked ~65 identical
 * brand-filled calls to action and a brand fill stopped meaning anything. It now
 * saves a category at a time, so there are a handful of Saves rather than 65,
 * but they are still a repeated, non-leading control.
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
    // resetting is the rarer and more destructive of the two. The Reset button
    // carries its own formAction on the category's form, so match the button
    // that holds the label rather than one exact spelling of its props.
    const reset = readFileSync(PAGE, "utf8").match(/<Button\b[^>]*>\s*Reset to default\s*<\/Button>/);
    expect(reset).not.toBeNull();
    expect(reset![0]).toContain('variant="ghost"');
  });
});
