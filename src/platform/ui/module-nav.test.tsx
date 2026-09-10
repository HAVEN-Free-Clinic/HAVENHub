import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModuleNav } from "./module-nav";

// Mutable so a case can place the viewer on a different route. Defaults to the
// route the characterization cases below were written against.
let pathname = "/admin/people";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

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


describe("ModuleNav with a tab nested under another tab", () => {
  // Three real pages sit under another tab's path and had no tab at all
  // because of it: /admin/email/templates, /volunteers/ehs/manage and
  // /schedule/attendings/credentialing. The registry carried a standing
  // warning to keep hrefs flat; these are the cases that let it be lifted.
  const NESTED = [
    { label: "Overview", href: "/admin" },
    { label: "Email", href: "/admin/email" },
    { label: "Email templates", href: "/admin/email/templates" },
  ];

  function renderAt(at: string, items = NESTED) {
    pathname = at;
    try {
      return renderToStaticMarkup(<ModuleNav items={items} />);
    } finally {
      pathname = "/admin/people";
    }
  }

  // next/link emits aria-current before href, so match in that order.
  function activeHrefs(out: string): string[] {
    return [...out.matchAll(/aria-current="page"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  }

  it("marks the deepest matching tab, and only it", () => {
    const out = renderAt("/admin/email/templates");
    expect(activeHrefs(out)).toEqual(["/admin/email/templates"]);
    // The parent tab is NOT also current: two aria-current tabs is what sent
    // scrollActiveTabIntoView (which takes the first match) to the wrong one.
    expect(out.match(/border-b-2 border-brand/g)).toHaveLength(1);
  });

  it("still marks the parent tab on the parent's own page", () => {
    expect(activeHrefs(renderAt("/admin/email"))).toEqual(["/admin/email"]);
  });

  it("marks the parent tab on a child route that has no tab of its own", () => {
    // /admin/email/senders is not a tab, so Email stays the active section.
    expect(activeHrefs(renderAt("/admin/email/senders"))).toEqual(["/admin/email"]);
  });

  it("does not let a tab claim a sibling route that merely shares its prefix", () => {
    // startsWith alone matched "/schedule/attendings-archive" against
    // "/schedule/attendings". The test is href + "/".
    const items = [
      { label: "Schedule", href: "/schedule" },
      { label: "Attendings", href: "/schedule/attendings" },
    ];
    expect(activeHrefs(renderAt("/schedule/attendings-archive", items))).toEqual([]);
  });

  it("never prefix-matches the module root", () => {
    expect(activeHrefs(renderAt("/admin/email"))).not.toContain("/admin");
  });
});

describe("ModuleNav with folded pages (underTab)", () => {
  const FOLDED = [
    { label: "My schedule", href: "/schedule" },
    { label: "Check in", href: "/schedule/check-in", underTab: "/schedule" },
    { label: "Attendings", href: "/schedule/attendings" },
    { label: "Credentialing", href: "/schedule/attendings/credentialing", underTab: "/schedule/attendings" },
    { label: "Specialties", href: "/schedule/specialties", underTab: "/schedule/attendings" },
  ];

  function renderAt(at: string) {
    pathname = at;
    try {
      return renderToStaticMarkup(<ModuleNav items={FOLDED} />);
    } finally {
      pathname = "/admin/people";
    }
  }

  function activeHrefs(out: string): string[] {
    return [...out.matchAll(/aria-current="page"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  }

  it("draws only the unfolded items", () => {
    const out = renderAt("/schedule");
    expect(out).toContain('href="/schedule"');
    expect(out).toContain('href="/schedule/attendings"');
    for (const folded of ["/schedule/check-in", "/schedule/attendings/credentialing", "/schedule/specialties"]) {
      expect(out).not.toContain(`href="${folded}"`);
    }
  });

  it("lights the parent tab on a folded page that shares no path with it", () => {
    expect(activeHrefs(renderAt("/schedule/specialties"))).toEqual(["/schedule/attendings"]);
  });

  it("lights the parent on a folded page below a module root, which otherwise never prefix-matches", () => {
    expect(activeHrefs(renderAt("/schedule/check-in"))).toEqual(["/schedule"]);
  });

  it("still lights the parent on a folded page's own sub-route", () => {
    expect(activeHrefs(renderAt("/schedule/specialties/abc"))).toEqual(["/schedule/attendings"]);
    expect(activeHrefs(renderAt("/schedule/attendings/credentialing"))).toEqual(["/schedule/attendings"]);
  });
});
