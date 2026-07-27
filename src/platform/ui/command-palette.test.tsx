import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandPalette, buildSections } from "./command-palette";
import type { NavModule } from "@/platform/modules/nav";

// CommandPalette is a client component; useRouter needs a stub under SSR.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

const ITEMS: NavModule[] = [
  { id: "schedule", title: "Schedule", href: "/schedule", nav: [{ label: "Builder", href: "/schedule/builder" }] },
];

describe("CommandPalette", () => {
  // The trigger is icon-only: the toolbar has no width for a labelled button
  // (see the Stage 2 section of the nav IA spec), so its name and its shortcut
  // are carried by aria-label and title rather than by visible text.
  it("renders a visible trigger named for search", () => {
    const out = renderToStaticMarkup(<CommandPalette items={ITEMS} />);
    expect(out).toContain('aria-label="Search"');
  });

  it("advertises the keyboard shortcut on the trigger, so it is discoverable", () => {
    const out = renderToStaticMarkup(<CommandPalette items={ITEMS} />);
    expect(out).toContain('title="Search (Cmd K)"');
    expect(out).toContain('aria-keyshortcuts="Meta+K Control+K"');
  });

  it("renders the dialog closed, so no results are in the initial markup", () => {
    const out = renderToStaticMarkup(<CommandPalette items={ITEMS} />);
    expect(out).not.toContain("/schedule/builder");
  });

  it("renders no dialog until it is opened, so the portal never runs on the server", () => {
    const out = renderToStaticMarkup(<CommandPalette items={ITEMS} />);
    expect(out).not.toContain('role="dialog"');
    expect(out).not.toContain('role="listbox"');
  });
});

describe("buildSections", () => {
  it("groups page hits under their owning module title", () => {
    const sections = buildSections(
      [
        { label: "Builder", href: "/schedule/builder", group: "Schedule", score: 0 },
        { label: "My schedule", href: "/schedule", group: "Schedule", score: 1 },
      ],
      [],
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("Schedule");
    expect(sections[0].rows.map((r) => r.href)).toEqual(["/schedule/builder", "/schedule"]);
  });

  it("keeps module sections in the order their best hit arrived, not alphabetically", () => {
    const sections = buildSections(
      [
        { label: "Speed route", href: "/recruitment/speed", group: "Recruitment", score: 0 },
        { label: "Builder", href: "/schedule/builder", group: "Schedule", score: 2 },
        { label: "Cycles", href: "/recruitment/cycles", group: "Recruitment", score: 3 },
      ],
      [],
    );
    expect(sections.map((s) => s.heading)).toEqual(["Recruitment", "Schedule"]);
    expect(sections[0].rows).toHaveLength(2);
  });

  it("orders entity sections People, Cycles, Requests and drops the empty ones", () => {
    const sections = buildSections(
      [],
      [
        { id: "r1", label: "Epic access", sub: "OPEN", href: "/support/r1", group: "Requests" },
        { id: "p1", label: "Ada Lovelace", sub: null, href: "/admin/people/p1", group: "People" },
      ],
    );
    expect(sections.map((s) => s.heading)).toEqual(["People", "Requests"]);
  });

  it("puts pages before entities so the instant results lead", () => {
    const sections = buildSections(
      [{ label: "People", href: "/admin/people", group: "Admin", score: 0 }],
      [{ id: "p1", label: "Ada Lovelace", sub: null, href: "/admin/people/p1", group: "People" }],
    );
    expect(sections.map((s) => s.heading)).toEqual(["Admin", "People"]);
  });

  it("numbers rows contiguously across sections, so one index walks the whole list", () => {
    const sections = buildSections(
      [{ label: "People", href: "/admin/people", group: "Admin", score: 0 }],
      [
        { id: "p1", label: "Ada Lovelace", sub: null, href: "/admin/people/p1", group: "People" },
        { id: "r1", label: "Epic access", sub: "OPEN", href: "/support/r1", group: "Requests" },
      ],
    );
    expect(sections.flatMap((s) => s.rows).map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it("carries the entity sub-label through, so a request shows its status", () => {
    const sections = buildSections(
      [],
      [{ id: "r1", label: "Epic access", sub: "OPEN", href: "/support/r1", group: "Requests" }],
    );
    expect(sections[0].rows[0].sub).toBe("OPEN");
  });

  it("returns no sections for no hits, which is what drives the empty state", () => {
    expect(buildSections([], [])).toEqual([]);
  });
});
