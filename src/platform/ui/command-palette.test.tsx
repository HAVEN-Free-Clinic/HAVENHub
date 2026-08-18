// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandPalette, buildSections, pageIndex } from "./command-palette";
import { matchPages } from "@/platform/search/match";
import type { NavModule } from "@/platform/modules/nav";

// CommandPalette is a client component; useRouter needs a stub under SSR.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS: NavModule[] = [
  { id: "schedule", title: "Schedule", href: "/schedule", nav: [{ label: "Builder", href: "/schedule/builder" }] },
];

describe("CommandPalette", () => {
  // The trigger is icon-only: the toolbar has no width for a labelled button
  // (see the Stage 2 section of the nav IA spec), so its name and its shortcut
  // are carried by aria-label and title rather than by visible text.
  it("renders a visible trigger named for search", () => {
    const out = renderToStaticMarkup(<CommandPalette items={ITEMS} />);
    // Qualified rather than a bare "Search": several pages have their own
    // filter-submit button with that exact accessible name.
    expect(out).toContain('aria-label="Search the hub"');
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

describe("pageIndex", () => {
  // /training reaches the palette through neither route the nav uses: it is not
  // a module, and My Info's manifest is flagged `personal` so it never lands in
  // `items`. Being unable to find /training is the exact problem this effort
  // exists to solve, so a query for it has to hit.
  it("finds Training, which is in no NavModule at all", () => {
    const hits = matchPages(pageIndex(ITEMS), "training");
    expect(hits.some((h) => h.href === "/training" && h.group === "Personal")).toBe(true);
  });

  it("finds My Info, which filterAccessibleModules drops as a personal module", () => {
    const hits = matchPages(pageIndex(ITEMS), "my info");
    expect(hits.some((h) => h.href === "/my-info")).toBe(true);
  });

  it("leaves the caller's permission-filtered modules untouched ahead of them", () => {
    expect(pageIndex(ITEMS).slice(0, ITEMS.length)).toEqual(ITEMS);
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

  // The response arrives as one flat array in whatever order the server built
  // it; the fixed ENTITY_GROUPS order is what keeps the list from reshuffling
  // as a viewer types, so it must not follow the array.
  it("orders entity sections by ENTITY_GROUPS and drops the empty ones", () => {
    const sections = buildSections(
      [],
      [
        { id: "r1", label: "Epic access", sub: "OPEN", href: "/support/r1", group: "Requests" },
        { id: "h1", label: "Ada Lovelace", sub: "al2345", href: "/recruitment/history/h1", group: "Recruitment history" },
        { id: "p1", label: "Ada Lovelace", sub: null, href: "/admin/people/p1", group: "People" },
      ],
    );
    expect(sections.map((s) => s.heading)).toEqual(["People", "Recruitment history", "Requests"]);
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

describe("CommandPalette global shortcut listener", () => {
  let mounted: { container: HTMLDivElement; root: Root } | null = null;

  afterEach(() => {
    if (mounted) {
      const { container, root } = mounted;
      act(() => root.unmount());
      container.remove();
      mounted = null;
    }
  });

  function mount() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<CommandPalette items={ITEMS} />));
    mounted = { container, root };
  }

  // A synthetic keydown from an extension, password manager, or IME shim can
  // arrive with no `key`. A plain Event has none, so it stands in for that.
  // jsdom reports a throw from a listener as a window "error" event rather than
  // rethrowing out of dispatch, so watch for that instead.
  it("bails quietly on a keydown that carries no key", () => {
    mount();
    const onError = vi.fn();
    window.addEventListener("error", onError);
    act(() => {
      document.dispatchEvent(new Event("keydown", { bubbles: true }));
    });
    window.removeEventListener("error", onError);
    expect(onError).not.toHaveBeenCalled();
  });
});
