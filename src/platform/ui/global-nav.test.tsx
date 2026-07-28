import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalNav } from "./global-nav";
import type { NavModule } from "@/platform/modules/nav";

// GlobalNav is a client component; usePathname needs a stub under SSR.
vi.mock("next/navigation", () => ({ usePathname: () => "/schedule" }));

const ITEMS: NavModule[] = [
  {
    id: "schedule",
    title: "Schedule",
    href: "/schedule",
    nav: [
      { label: "My schedule", href: "/schedule" },
      { label: "Builder", href: "/schedule/builder" },
    ],
  },
  { id: "recruitment", title: "Recruitment", href: "/recruitment", nav: [{ label: "Cycles", href: "/recruitment" }] },
  { id: "clinic", title: "Clinic", href: "/clinic", nav: [] },
];

describe("GlobalNav module dropdowns", () => {
  it("renders a disclosure only for modules with two or more sub-items", () => {
    const out = renderToStaticMarkup(<GlobalNav items={ITEMS} />);
    expect(out).toContain('aria-label="Schedule sub-pages"');
    expect(out).not.toContain('aria-label="Recruitment sub-pages"');
    expect(out).not.toContain('aria-label="Clinic sub-pages"');
  });

  it("keeps the module label a link to the module root", () => {
    const out = renderToStaticMarkup(<GlobalNav items={ITEMS} />);
    expect(out).toContain('href="/schedule"');
    expect(out).toContain("Schedule");
  });

  it("keeps sub-page links closed until the disclosure is activated", () => {
    // Panels are state-driven, so nothing sub-page-specific is in the initial markup.
    const out = renderToStaticMarkup(<GlobalNav items={ITEMS} />);
    expect(out).not.toContain('href="/schedule/builder"');
  });

  it("renders every module in the measurement layer so sizing accounts for all of them", () => {
    const out = renderToStaticMarkup(<GlobalNav items={ITEMS} />);
    expect(out).toContain("data-measure-item");
    expect(out).toContain("data-measure-more");
  });

  it("renders nothing when the viewer can access no modules", () => {
    expect(renderToStaticMarkup(<GlobalNav items={[]} />)).toBe("");
  });
});
