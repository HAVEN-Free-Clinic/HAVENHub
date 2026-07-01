"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Menu, X } from "lucide-react";
import { isModuleActive, type NavModule } from "@/platform/modules/access";

/** useLayoutEffect on the client, useEffect on the server (SSR-safe). */
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** gap-1 between nav items, in px; kept in sync with the className below. */
const NAV_GAP = 4;

function linkClasses(active: boolean): string {
  return active
    ? "rounded-lg px-2.5 py-1.5 text-sm font-medium text-brand-fg bg-brand-faint"
    : "rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors";
}

export function GlobalNav({ items }: { items: NavModule[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // Start by assuming everything fits; the layout effect trims before paint.
  const [visibleCount, setVisibleCount] = useState(items.length);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const itemWidths = useRef<number[]>([]);
  const moreWidth = useRef(0);

  /**
   * Decide how many links fit on one line; the rest collapse under "More".
   * Reads cached widths from the hidden measurement layer, so it is cheap to
   * call on every resize.
   */
  const recompute = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const available = nav.clientWidth;
    const widths = itemWidths.current;
    if (widths.length === 0 || available === 0) return;

    const totalWithGaps = widths.reduce(
      (sum, w, i) => sum + w + (i > 0 ? NAV_GAP : 0),
      0,
    );
    if (totalWithGaps <= available) {
      setVisibleCount(widths.length);
      return;
    }

    // Overflow: reserve room for the "More" button and fit what's left.
    const reserve = moreWidth.current + NAV_GAP;
    let used = 0;
    let count = 0;
    for (let i = 0; i < widths.length; i++) {
      const next = widths[i] + (i > 0 ? NAV_GAP : 0);
      if (used + next + reserve <= available) {
        used += next;
        count++;
      } else {
        break;
      }
    }
    setVisibleCount(count);
  }, []);

  // Cache item widths from the hidden measurement layer, then size the nav.
  useIsomorphicLayoutEffect(() => {
    const measure = measureRef.current;
    if (!measure) return;
    itemWidths.current = Array.from(
      measure.querySelectorAll<HTMLElement>("[data-measure-item]"),
    ).map((el) => el.offsetWidth);
    const more = measure.querySelector<HTMLElement>("[data-measure-more]");
    moreWidth.current = more?.offsetWidth ?? 0;
    recompute();
  }, [items, recompute]);

  // Recompute on container resize.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(nav);
    return () => ro.disconnect();
  }, [recompute]);

  // Font swaps can change text widths after first paint; remeasure once ready.
  useEffect(() => {
    const fonts = (
      document as Document & { fonts?: { ready: Promise<unknown> } }
    ).fonts;
    if (!fonts) return;
    let cancelled = false;
    fonts.ready.then(() => {
      if (cancelled) return;
      const measure = measureRef.current;
      if (measure) {
        itemWidths.current = Array.from(
          measure.querySelectorAll<HTMLElement>("[data-measure-item]"),
        ).map((el) => el.offsetWidth);
        const more = measure.querySelector<HTMLElement>("[data-measure-more]");
        moreWidth.current = more?.offsetWidth ?? 0;
      }
      recompute();
    });
    return () => {
      cancelled = true;
    };
  }, [recompute]);

  // Escape closes whichever menu is open and restores focus to the toggle.
  useEffect(() => {
    if (!open && !moreOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setMoreOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, moreOpen]);

  // Click outside the "More" dropdown closes it.
  useEffect(() => {
    if (!moreOpen) return;
    function handlePointerDown(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [moreOpen]);

  if (items.length === 0) return null;

  const visible = items.slice(0, visibleCount);
  const overflow = items.slice(visibleCount);
  const overflowHasActive = overflow.some((m) => isModuleActive(pathname, m.href));

  return (
    <>
      {/* Desktop: inline links with a priority+ "More" overflow menu. */}
      <nav
        ref={navRef}
        aria-label="Modules"
        className="hidden items-center gap-1 sm:flex"
      >
        {visible.map((m) => {
          const active = isModuleActive(pathname, m.href);
          return (
            <Link
              key={m.id}
              href={m.href}
              aria-current={active ? "page" : undefined}
              className={linkClasses(active)}
            >
              {m.title}
            </Link>
          );
        })}

        {overflow.length > 0 && (
          <div ref={moreRef} className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
              className={`inline-flex items-center gap-1 ${linkClasses(overflowHasActive)}`}
            >
              More
              <ChevronDown aria-hidden className="h-3.5 w-3.5" />
            </button>
            {moreOpen && (
              <div
                role="menu"
                aria-label="More modules"
                className="absolute right-0 top-full z-20 mt-1 flex min-w-44 flex-col gap-1 rounded-xl border border-border bg-surface p-1.5 shadow-lg"
              >
                {overflow.map((m) => {
                  const active = isModuleActive(pathname, m.href);
                  return (
                    <Link
                      key={m.id}
                      href={m.href}
                      role="menuitem"
                      aria-current={active ? "page" : undefined}
                      onClick={() => setMoreOpen(false)}
                      className={`block ${linkClasses(active)}`}
                    >
                      {m.title}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Hidden measurement layer: full list + More, measured for sizing. */}
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 hidden h-0 items-center gap-1 overflow-hidden whitespace-nowrap opacity-0 sm:flex"
      >
        {items.map((m) => (
          <span key={m.id} data-measure-item className={linkClasses(false)}>
            {m.title}
          </span>
        ))}
        <span
          data-measure-more
          className={`inline-flex items-center gap-1 ${linkClasses(false)}`}
        >
          More
          <ChevronDown aria-hidden className="h-3.5 w-3.5" />
        </span>
      </div>

      {/* Mobile: hamburger + dropdown */}
      <div className="sm:hidden">
        <button
          ref={buttonRef}
          type="button"
          aria-label="Open navigation menu"
          aria-expanded={open}
          aria-controls="global-nav-mobile"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-foreground-soft hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          {open ? <X aria-hidden className="h-5 w-5" /> : <Menu aria-hidden className="h-5 w-5" />}
        </button>
        {open && (
          <nav
            id="global-nav-mobile"
            aria-label="Modules (menu)"
            className="absolute left-0 right-0 top-14 z-20 border-b border-border bg-surface shadow-sm"
          >
            <div className="mx-auto flex max-w-6xl flex-col gap-1 px-6 py-3">
              {items.map((m) => {
                const active = isModuleActive(pathname, m.href);
                return (
                  <Link
                    key={m.id}
                    href={m.href}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setOpen(false)}
                    className={`block ${linkClasses(active)}`}
                  >
                    {m.title}
                  </Link>
                );
              })}
            </div>
          </nav>
        )}
      </div>
    </>
  );
}
