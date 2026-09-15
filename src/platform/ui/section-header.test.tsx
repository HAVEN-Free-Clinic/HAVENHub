import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionHeader } from "./section-header";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("SectionHeader levels", () => {
  it("emits exactly the class string the migrated headings hand-rolled", () => {
    // Seventeen headings were byte-identical to these two, which is why the
    // migration is a no-op visually. If either string drifts, that stops being
    // true silently -- so both are pinned here rather than inferred.
    expect(render(<SectionHeader level="title">x</SectionHeader>)).toContain(
      'class="text-base font-semibold text-foreground"',
    );
    expect(render(<SectionHeader level="card" as="h3">x</SectionHeader>)).toContain(
      'class="text-sm font-semibold text-foreground-soft"',
    );
  });

  it("keeps `card` distinct from `title`, which is the reason it exists", () => {
    // A card's own edge already marks the group, so the heading inside it is
    // quieter than a page-level one. Collapsing them would make eight admin
    // panels shout.
    const card = render(<SectionHeader level="card" as="h3">x</SectionHeader>);
    const title = render(<SectionHeader level="title">x</SectionHeader>);
    expect(card).not.toBe(title);
  });

  it("renders the heading level the caller asks for, so the outline does not skip", () => {
    // The admin panels nest under a page h1 and a section h2, so they pass h3.
    expect(render(<SectionHeader level="card" as="h3">x</SectionHeader>)).toContain("<h3");
    expect(render(<SectionHeader level="title">x</SectionHeader>)).toContain("<h2");
  });

  it("takes outer spacing from className without losing its own classes", () => {
    // The migrated sites carried mb-4 / mb-2 on the element they replaced.
    const out = render(<SectionHeader level="card" as="h3" className="mb-4">x</SectionHeader>);
    expect(out).toContain("mb-4");
    expect(out).toContain("text-foreground-soft");
  });
});

describe("the group level", () => {
  it("is a rung on the ladder, not a caller's text-xl", () => {
    // Three pages reached this size by passing className="text-xl" to a
    // `title`. A caller class fighting a primitive's own class is
    // emission-order roulette here: this repo has no tailwind-merge, so
    // whichever of text-base and text-xl Tailwind emits later wins, not
    // whichever the caller wrote last.
    expect(render(<SectionHeader level="group">Term</SectionHeader>)).toContain(
      'class="text-xl font-semibold text-foreground"',
    );
  });

  it("is a step above title, which is what makes it a level", () => {
    const group = render(<SectionHeader level="group">x</SectionHeader>);
    const title = render(<SectionHeader level="title">x</SectionHeader>);
    expect(group).not.toBe(title);
    expect(group).toContain("text-xl");
    expect(title).toContain("text-base");
  });
});
