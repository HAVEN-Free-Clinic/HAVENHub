import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Breadcrumbs } from "./breadcrumbs";
import { buildBreadcrumbs, type BreadcrumbModule } from "./breadcrumb-trail";
import { BreadcrumbProvider, SetBreadcrumbLeaf } from "./breadcrumb-context";

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

describe("Breadcrumbs with a page-supplied leaf", () => {
  // SetBreadcrumbLeaf is what eighteen detail routes use: the registry already
  // knows Hub > Module > Section, and the page adds only the record's name.
  // Rendering through the real provider is the only way to prove the two halves
  // compose, so these cases mount it rather than stubbing the context.
  function renderWithLeaf(at: string, label: string) {
    pathname = at;
    return renderToStaticMarkup(
      <BreadcrumbProvider>
        <SetBreadcrumbLeaf label={label} />
        <Breadcrumbs modules={MODULES} />
      </BreadcrumbProvider>,
    );
  }

  it("names the record and keeps the section linked as the way out", () => {
    // renderToStaticMarkup runs no effects, so the leaf is not applied on the
    // server pass -- which is the documented behaviour: first paint shows the
    // route-derived trail and the leaf lands after hydration. What this asserts
    // is that the escape link survives either way.
    const out = renderWithLeaf("/volunteers/directory/abc123", "Ada Lovelace");
    expect(out).toContain('href="/volunteers/directory"');
    expect(out).toContain("Directory");
  });

  it("appends the leaf as the current page once applied", () => {
    // The composition itself, tested where it lives: buildBreadcrumbs is what
    // Breadcrumbs calls with the leaf the context hands it.
    const crumbs = buildBreadcrumbs("/volunteers/directory/abc123", MODULES, "Ada Lovelace");
    expect(crumbs.map((c) => c.label)).toEqual(["Hub", "Volunteers", "Directory", "Ada Lovelace"]);
    // The leaf has no href, so the renderer marks it aria-current and the
    // section above it stays clickable.
    expect(crumbs[crumbs.length - 1].href).toBeUndefined();
    expect(crumbs[2].href).toBe("/volunteers/directory");
  });

  it("ignores a leaf left behind by a page the viewer has navigated away from", () => {
    // The override is keyed by pathname for exactly this reason: a stale leaf
    // must not label a different record.
    const crumbs = buildBreadcrumbs("/volunteers/directory", MODULES, undefined);
    expect(crumbs.map((c) => c.label)).toEqual(["Hub", "Volunteers", "Directory"]);
  });
});
