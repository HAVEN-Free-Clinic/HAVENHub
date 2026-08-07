"use client";

// Aliased: the two document-level handlers below take the DOM KeyboardEvent,
// so React's synthetic one must not shadow the global name.
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { cx } from "@/platform/ui/cx";
import { matchPages, type PageHit } from "@/platform/search/match";
import { ENTITY_GROUPS, type EntityHit } from "@/platform/search/types";
import type { NavModule } from "@/platform/modules/nav";

/** One rendered result. `index` is its position in the flat keyboard list. */
export type PaletteRow = {
  key: string;
  label: string;
  sub: string | null;
  href: string;
  index: number;
};

/** A headed run of rows: one module title, or one entity group. */
export type PaletteSection = { heading: string; rows: PaletteRow[] };

/**
 * The server refuses to search entities below this length (see
 * src/modules/search/entities.ts), so the palette says so rather than firing a
 * request it knows will come back empty.
 */
const MIN_ENTITY_QUERY = 2;

/** How long typing must pause before the entity request goes out. */
const DEBOUNCE_MS = 200;

/**
 * The personal pages, which are exactly the ones the nav ROW leaves out.
 *
 * My Info is flagged `personal` in the module registry, so
 * filterAccessibleModules drops it and it never reaches `items`; Training is
 * not a module at all and lives only in the account menu. Leaving them out of
 * the palette too would mean Cmd+K then "training" finds nothing, and /training
 * being hard to reach is the problem this whole effort exists to solve.
 *
 * Hardcoded rather than read from the registry on purpose: this is a "use
 * client" component and must not pull the server registry (and PrismaClient
 * behind it) into the browser bundle. Safe to append unconditionally, with no
 * gate of its own, because both destinations are open to every signed-in
 * person: My Info's manifest declares no accessPermission, and /training gates
 * on requirePersonSession() alone.
 *
 * The module root doubles as the My Info entry. matchPages only skips a
 * duplicate href once an earlier candidate for it actually matched, so
 * "my info" still finds the row below even though the root shares its href.
 */
const PERSONAL_PAGES: NavModule = {
  id: "personal",
  title: "Personal",
  href: "/my-info",
  nav: [
    { label: "My Info", href: "/my-info" },
    { label: "Training", href: "/training" },
  ],
};

/**
 * Everything the palette's page index covers: the viewer's permission-filtered
 * modules first, then the personal pages.
 */
export function pageIndex(items: NavModule[]): NavModule[] {
  return [...items, PERSONAL_PAGES];
}

/**
 * Lay page hits and entity hits out as headed sections, numbering every row
 * with its position in the flat list Up/Down walks.
 *
 * Pages come first because they are instant and local; entities follow in the
 * fixed ENTITY_GROUPS order so the list does not reshuffle as responses land.
 * Module sections keep the order their best-scoring hit
 * arrived in (matchPages is already sorted), so the strongest match stays at
 * the top rather than being pushed down by an alphabetical heading sort.
 */
export function buildSections(pages: PageHit[], entities: EntityHit[]): PaletteSection[] {
  const sections: PaletteSection[] = [];
  let index = 0;

  const byModule = new Map<string, PaletteRow[]>();
  for (const hit of pages) {
    let rows = byModule.get(hit.group);
    if (!rows) {
      rows = [];
      byModule.set(hit.group, rows);
      sections.push({ heading: hit.group, rows });
    }
    rows.push({ key: `page:${hit.href}`, label: hit.label, sub: null, href: hit.href, index: index++ });
  }

  for (const group of ENTITY_GROUPS) {
    const hits = entities.filter((e) => e.group === group);
    if (hits.length === 0) continue;
    sections.push({
      heading: group,
      rows: hits.map((e) => ({
        key: `${group}:${e.id}`,
        label: e.label,
        sub: e.sub,
        href: e.href,
        index: index++,
      })),
    });
  }

  return sections;
}

/** True when the event landed in something the user is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
  return el.isContentEditable === true;
}

/**
 * True when a modal dialog other than `own` is open.
 *
 * Modal (src/platform/ui/modal.tsx) and this palette are near-twins: both sit
 * at z-50, both listen on document, both trap Tab, and Escape closes both at
 * once. Opening the palette over an already-open Modal stacks two Tab traps on
 * one screen, so the shortcut stands down instead. `own` is excluded so the
 * palette's own dialog does not block the shortcut from toggling it closed.
 */
function otherModalOpen(own: HTMLElement | null): boolean {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
  for (const dialog of dialogs) if (dialog !== own) return true;
  return false;
}

/**
 * The Cmd+K / Ctrl+K command palette: a jump-to search over the pages the
 * viewer can open plus the people, cycles, past applicants, and requests they
 * may see.
 *
 * `items` is the same permission-filtered NavModule list the global nav
 * renders, so the page index inherits that filtering and this component
 * performs no access control of its own. The one thing it adds is
 * PERSONAL_PAGES, which needs none: both of those pages are open to every
 * signed-in person. Entity results are filtered server-side by /api/search;
 * nothing here re-filters or could widen them.
 *
 * The dialog portals to document.body deliberately. The toolbar carries
 * `.glass-bar`, whose backdrop-filter establishes a containing block that
 * clips and mispositions fixed overlays rendered inside it (#304).
 *
 * Its dialog mechanics (portal, body-scroll lock, capture-phase Escape, Tab
 * trap, focus restoration) mirror src/platform/ui/modal.tsx rather than
 * composing with it: Modal owns a titled header row and a close button where
 * this needs its combobox input, centres a much wider panel, focuses the panel
 * instead of a specific control, and restores focus to whatever was focused at
 * open time, which for a Cmd+K press is usually nothing.
 */
export function CommandPalette({ items }: { items: NavModule[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Entity hits are stored WITH the query that produced them. Rendering is
  // gated on that query still matching the input, so a response that arrives
  // after the user typed on can never be drawn (see `entityHits` below).
  const [entities, setEntities] = useState<{ q: string; hits: EntityHit[] }>({ q: "", hits: [] });
  const [active, setActive] = useState(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set just before a router.push so the close cleanup leaves focus alone: the
  // page being navigated to should own focus, not the toolbar we came from.
  const navigatingRef = useRef(false);
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  const trimmed = query.trim();
  const entityHits = entities.q === trimmed ? entities.hits : [];
  const sections = buildSections(matchPages(pageIndex(items), trimmed), entityHits);
  const rows = sections.flatMap((s) => s.rows);
  // Clamped rather than corrected in state: results change under the cursor as
  // entity responses land, and clamping keeps render pure.
  const activeIndex = rows.length === 0 ? 0 : Math.min(active, rows.length - 1);
  // No stored response for the current query yet, so one is debouncing or in
  // flight. Derived, so there is no third piece of state to keep in step.
  const searching = trimmed.length >= MIN_ENTITY_QUERY && entities.q !== trimmed;

  // Global shortcut, a toggle. Ignored while the user is typing somewhere else,
  // so a Cmd+K inside a form field never yanks them out of it, and
  // preventDefault only fires once we are certain we are handling the key.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "k") return;
      if (!e.metaKey && !e.ctrlKey) return;
      // The typing-target guard must NOT apply to the palette's own input,
      // which is focused the whole time the palette is open. Bailing there
      // would leave the browser default unsuppressed, and Firefox's Ctrl+K
      // (focus the browser search bar) would pull focus out of the open dialog.
      if (e.target !== inputRef.current && isTypingTarget(e.target)) return;
      // Some other modal owns the screen: leave the key to it rather than
      // stacking a second dialog (and a second Tab trap) on top.
      if (otherModalOpen(panelRef.current)) return;
      e.preventDefault();
      setOpen((v) => !v);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Open-state mechanics, mirroring Modal: scroll lock, Escape, Tab trap, and
  // focus restored to the trigger on close.
  useEffect(() => {
    if (!open) return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus();
    // Captured now rather than read in the cleanup: the trigger renders
    // unconditionally alongside the dialog, so the node is stable, and reading
    // a ref from a cleanup is the pattern that bites when it is not.
    const trigger = triggerRef.current;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement;
      // Focus escaped the panel (the browser blurs to <body> whenever the
      // focused control is removed): pull it back before the default runs,
      // or Tab walks into the scroll-locked page behind the scrim.
      if (!activeEl || !panelRef.current?.contains(activeEl)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && (activeEl === first || activeEl === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      if (navigatingRef.current) navigatingRef.current = false;
      else trigger?.focus();
    };
  }, [open]);

  // Debounced entity search. The cleanup both clears a pending timer and
  // aborts an in-flight request, so only the last keystroke's query is ever
  // on the wire; the stored-query guard below covers the rest.
  useEffect(() => {
    if (!open) return;
    const q = trimmed;
    if (q.length < MIN_ENTITY_QUERY) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      async function run() {
        try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          // A 503 (database unreachable) or a 401 leaves the page results
          // alone and simply contributes no entities. Nothing is surfaced to
          // the user: search is an accelerator, not a task they are mid-way
          // through, and an error banner over it would be pure noise.
          if (!res.ok) {
            setEntities({ q, hits: [] });
            return;
          }
          const json = (await res.json()) as { results?: EntityHit[] };
          setEntities({ q, hits: json.results ?? [] });
        } catch {
          // An abort is the expected path once the query has moved on, and its
          // result is stale by definition, so leave the stored one alone.
          // Anything else is a real throw (offline, DNS) and must still SETTLE
          // this query the way a non-ok response does: `searching` is derived
          // from "no stored response for the current query", so without this
          // the empty state reads "Searching..." until the next keystroke.
          if (!controller.signal.aborted) setEntities({ q, hits: [] });
        }
      }
      void run();
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, trimmed]);

  // Keep the keyboard-selected row in view: the list scrolls, so without this
  // the selection walks off the bottom and the user picks blind.
  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
    // optionId is derived from the render-stable useId, so uid is the real dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex, uid]);

  function close() {
    setOpen(false);
  }

  function go(href: string) {
    navigatingRef.current = true;
    setOpen(false);
    setQuery("");
    setActive(0);
    router.push(href);
  }

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      // Always swallow Enter so it can never reach a surrounding form.
      e.preventDefault();
      const row = rows[activeIndex];
      if (row) go(row.href);
    }
  }

  return (
    <>
      {/* Icon-only, and the same h-9 w-9 square as ThemeToggle and
          NotificationBell beside it. The toolbar has no width for a labelled
          button (see the Stage 2 section of the nav IA spec): the word and the
          shortcut badge would cost roughly 115px against a budget of about 48.
          The magnifier carries the affordance, the title reveals the shortcut
          on hover, and the palette repeats it beside its own input. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        // Qualified rather than a bare "Search": several pages carry their own
        // filter-submit button whose accessible name is exactly "Search"
        // (e.g. /admin/people), and a bare "Search" here would be ambiguous
        // both to screen-reader users (two same-named controls that do
        // different things) and to role-based test selectors.
        aria-label="Search the hub"
        title="Search (Cmd K)"
        aria-keyshortcuts="Meta+K Control+K"
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <Search aria-hidden className="h-4 w-4" />
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/50 p-4 pt-[12vh] backdrop-blur-sm" /* fixed dark scrim: must not theme-flip */
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label="Search"
              tabIndex={-1}
              className="glass-panel flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl outline-none"
            >
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <Search aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  ref={inputRef}
                  type="text"
                  role="combobox"
                  aria-expanded={rows.length > 0}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={rows.length > 0 ? optionId(activeIndex) : undefined}
                  aria-label="Search pages, people, cycles, past applicants, and requests"
                  placeholder="Search pages, people, cycles, applicants, requests"
                  autoComplete="off"
                  className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-subtle-foreground"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onInputKeyDown}
                />
                {/* The shortcut lives here rather than on the toolbar trigger,
                    where it would cost width the nav row does not have. */}
                <kbd
                  aria-hidden
                  className="shrink-0 rounded border border-border-strong px-1.5 py-0.5 font-sans text-[10px] font-medium text-subtle-foreground"
                >
                  ⌘K
                </kbd>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                <div id={listId} role="listbox" aria-label="Search results">
                  {sections.map((section, si) => (
                    <div key={`${si}-${section.heading}`} role="group" aria-labelledby={`${uid}-grp-${si}`}>
                      <div
                        id={`${uid}-grp-${si}`}
                        className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground"
                      >
                        {section.heading}
                      </div>
                      {section.rows.map((row) => (
                        <div
                          key={row.key}
                          id={optionId(row.index)}
                          role="option"
                          aria-selected={row.index === activeIndex}
                          onMouseEnter={() => setActive(row.index)}
                          // onMouseDown, not onClick: the press must not blur
                          // the input before the navigation runs.
                          onMouseDown={(e) => {
                            e.preventDefault();
                            go(row.href);
                          }}
                          className={cx(
                            "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm",
                            row.index === activeIndex
                              ? "bg-brand-faint text-brand-fg"
                              : "text-foreground-soft",
                          )}
                        >
                          <span className="min-w-0 truncate">{row.label}</span>
                          {row.sub && (
                            <span className="ml-auto shrink-0 text-xs text-subtle-foreground">
                              {row.sub}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                {trimmed.length < MIN_ENTITY_QUERY ? (
                  <p className="px-3 py-3 text-xs text-muted-foreground">
                    Pages match from the first letter. People, cycles, past applicants, and requests
                    need at least {MIN_ENTITY_QUERY} characters.
                  </p>
                ) : (
                  rows.length === 0 && (
                    <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
                      {searching ? "Searching..." : `No results for "${trimmed}"`}
                    </p>
                  )
                )}
              </div>

              <div className="border-t border-border px-4 py-2 text-[11px] text-subtle-foreground">
                Cmd K or Ctrl K opens this anywhere. Up and Down to move, Enter to open, Esc to
                close.
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
