import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModuleNav } from "./module-nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/people" }));

const ITEMS = [
  { label: "Overview", href: "/admin" },
  { label: "People", href: "/admin/people" },
  { label: "Terms", href: "/admin/terms" },
];

describe("ModuleNav characterization (must pass before and after the refactor)", () => {
  it("renders every item with its href", () => {
    const out = renderToStaticMarkup(<ModuleNav items={ITEMS} />);
    for (const i of ITEMS) expect(out).toContain(`href="${i.href}"`);
  });

  it("marks the deep sub-page active, not the module root", () => {
    const out = renderToStaticMarkup(<ModuleNav items={ITEMS} />);
    // Exactly one item carries the active border/colour classes.
    expect(out.match(/border-b-2 border-brand/g)).toHaveLength(1);
    // And it is on the People link, not the Overview (module root) link.
    const peopleSegment = out.slice(
      out.indexOf('href="/admin/people"') - 200,
      out.indexOf('href="/admin/people"') + 200,
    );
    expect(peopleSegment).toContain("border-b-2 border-brand");
  });

  it("names the nav landmark \"Module\"", () => {
    const out = renderToStaticMarkup(<ModuleNav items={ITEMS} />);
    expect(out).toContain('aria-label="Module"');
  });
});

describe("ModuleNav accessibility addition (fails before the refactor, passes after)", () => {
  it("exposes the active tab via aria-current, not colour alone", () => {
    // Before this refactor, ModuleNav signalled the active tab only through
    // the active class string (border-brand / text-brand-fg) -- a WCAG 1.4.1
    // colour-only failure. GlobalNav (src/platform/ui/global-nav.tsx) already
    // sets aria-current on its active link, and TabRow does too, so this
    // closes ModuleNav's gap against the app's own convention. This is an
    // intentional, in-scope addition, not a regression: it does not change
    // any existing class string or the active-matching rule, and aria-current
    // does not alter an element's accessible name.
    const out = renderToStaticMarkup(<ModuleNav items={ITEMS} />);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    const peopleSegment = out.slice(
      out.indexOf('href="/admin/people"') - 200,
      out.indexOf('href="/admin/people"') + 200,
    );
    expect(peopleSegment).toContain('aria-current="page"');
  });
});
