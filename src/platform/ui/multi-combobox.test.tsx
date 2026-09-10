import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MultiCombobox } from "./multi-combobox";

// Static markup only, like combobox.test.tsx's non-interactive cases: useState
// and useId render fine under renderToStaticMarkup, and `defaultValue` puts a
// chip on the very first render, which is all these need.
const render = () =>
  renderToStaticMarkup(
    <MultiCombobox
      name="departments"
      ariaLabel="Departments"
      options={[{ value: "a", label: "Internal Medicine" }]}
      defaultValue={["a"]}
    />,
  );

const removeClass = (html: string) =>
  html.match(/<button[^>]*aria-label="Remove Internal Medicine"[^>]*class="([^"]*)"/)?.[1] ??
  html.match(/<button[^>]*class="([^"]*)"[^>]*aria-label="Remove Internal Medicine"/)?.[1] ??
  "";

describe("MultiCombobox chip remove", () => {
  it("clears the 24px target floor", () => {
    // It was a bare glyph with no sized box at all, about 16px, under WCAG 2.2
    // SC 2.5.8. The chips sit shoulder to shoulder on /recruitment/cycles/new
    // and /recruitment/cycles/<id>, so a mis-tap removed the NEIGHBOURING
    // department rather than missing.
    const cls = removeClass(render());
    for (const c of ["inline-flex", "min-h-6", "min-w-6", "items-center", "justify-center"]) {
      expect(cls).toContain(c);
    }
  });

  it("keeps the chip height unchanged while growing the target", () => {
    // -my-1, not -my-0.5. The chip's flex line is the label's text-xs 16px
    // line-height, so a 24px button needs 4px cancelled per side to keep its
    // margin box at 16px. -my-0.5 leaves a 20px margin box and grows every chip
    // by 4px, which shifts the wrapped chip rows on cycles/<id>.
    expect(removeClass(render())).toContain("-my-1");
  });

  it("carries the app focus ring", () => {
    // There was no focus rule on it at all, so a keyboard user tabbing onto it
    // got the browser default outline rather than the brand ring every other
    // control in the app shows.
    expect(removeClass(render())).toContain("focus-visible:outline-brand");
  });

  it("renders an icon, not a bare text glyph", () => {
    const out = render();
    expect(out).not.toContain("×");
    expect(out).toContain("<svg");
  });

  it("leaves the accessible name alone", () => {
    // The only thing anything (including e2e) queries this button by. Swapping
    // the glyph for an icon must not silently un-name it.
    expect(render()).toContain('aria-label="Remove Internal Medicine"');
  });
});

describe("the house style records the target-size floor", () => {
  it("names SC 2.5.8 and both floors, so the next inline control does not argue it from scratch", () => {
    // field-picker.tsx had to justify the 24px floor in an inline comment
    // because docs/ui-house-style.md's design-token section had no target-size
    // row at all.
    const doc = readFileSync(join(process.cwd(), "docs/ui-house-style.md"), "utf8");
    expect(doc).toContain("2.5.8");
    expect(doc).toContain("min-h-6");
    expect(doc).toContain("min-h-11");
  });
});
