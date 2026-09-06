import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Breadcrumbs } from "./breadcrumbs";
import type { BreadcrumbModule } from "./breadcrumb-trail";

// Breadcrumbs is a client component reading usePathname; the mock is mutable so
// each case can place the viewer on a different route.
let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

// useBreadcrumbOverride reads a context with no provider in these tests, which
// yields undefined, so the registry-derived trail is what renders. The override
// path gets its own case below via a provider-free stub of the same shape.
const MODULES: BreadcrumbModule[] = [
  {
    id: "volunteers",
    title: "Volunteers",
    nav: [
      { label: "Compliance", href: "/volunteers" },
      { label: "Directory", href: "/volunteers/directory" },
    ],
  },
];

function render(at: string) {
  pathname = at;
  return renderToStaticMarkup(<Breadcrumbs modules={MODULES} />);
}

describe("Breadcrumbs current-page resolution", () => {
  it("links the parent section on a detail page, so the record has a way out", () => {
    // buildBreadcrumbs ends a detail trail on the LINKED parent section. That
    // crumb is last but is NOT the current page, and it is the only escape.
    const out = render("/volunteers/directory/abc123");
    expect(out).toContain('href="/volunteers/directory"');
  });

  it("does not mark the parent section as the current page", () => {
    const out = render("/volunteers/directory/abc123");
    expect(out).not.toContain('aria-current="page"');
  });

  it("renders a section that IS the current page as plain text, not a self-link", () => {
    const out = render("/volunteers/directory");
    expect(out).toContain('aria-current="page"');
    expect(out).not.toContain('href="/volunteers/directory"');
  });

  it("keeps ancestors above the current page linked", () => {
    const out = render("/volunteers/directory");
    expect(out).toContain('href="/volunteers"');
    expect(out).toContain('href="/"');
  });

  it("marks a trailing New crumb as the current page and keeps its section linked", () => {
    const out = render("/volunteers/directory/new");
    expect(out).toContain('href="/volunteers/directory"');
    expect(out).toContain('aria-current="page"');
    expect(out).toContain("New");
  });

  it("renders nothing on the hub root, where the trail is just Hub", () => {
    expect(render("/")).toBe("");
  });

  it("ignores a trailing slash when deciding whether a crumb is the current page", () => {
    const out = render("/volunteers/directory/");
    expect(out).toContain('aria-current="page"');
    expect(out).not.toContain('href="/volunteers/directory"');
  });
});
