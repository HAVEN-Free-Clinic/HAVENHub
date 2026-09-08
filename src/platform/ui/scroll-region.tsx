"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";

/**
 * A horizontally scrolling region a keyboard can actually reach.
 *
 * Every wide table and grid in the app scrolls sideways, and none of them could
 * be scrolled without a mouse. A scroll container is not focusable by default,
 * and these have no focusable descendant in their off-screen columns, so there
 * was nothing to Tab to that would pull the container across. On
 * /credential/[token] and the compliance rosters that meant a keyboard or
 * switch-access user simply could not read the right-hand columns.
 *
 * ## Only focusable when it actually overflows
 *
 * `tabindex="0"` on ~50 containers would add ~50 tab stops, most of them dead:
 * the majority of these tables fit their width and have nothing to scroll. So
 * this measures instead, with a ResizeObserver on the container and its content,
 * and takes the tab stop only while there is genuinely something off-screen.
 *
 * Server-rendered output starts non-focusable and gains the tab stop on mount.
 * That is the right way round: a container that cannot scroll should never have
 * been a stop, and one that can becomes reachable as soon as the measurement
 * lands.
 *
 * ## Why it takes the tab stop even without a label
 *
 * The audit that found this proposed the opposite, making the tab stop
 * conditional on a caller-supplied name so an unnamed region is never announced.
 * That trade is backwards for this codebase: 46 tables would have to be renamed
 * one by one before any of them became operable, and until then a keyboard user
 * still could not read them. Being unable to reach content is a keyboard-operable
 * failure; an unnamed group is a naming nicety. So the stop is unconditional
 * (when scrollable) and `label` is an optional improvement on top, which callers
 * can add as they go.
 */
export function ScrollRegion({
  label,
  className,
  children,
}: {
  /** Accessible name, e.g. "Master compliance roster". Worth adding; not required. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScrollable(el.scrollWidth > el.clientWidth + 1);
    measure();
    // Watch the container AND its content: a filter that removes columns, or a
    // font that loads late, changes the answer without a window resize.
    //
    // Guarded because ResizeObserver is not universal: jsdom has none, so every
    // component test that renders a Table would otherwise throw here rather than
    // test what it came to test. Without the observer the measurement above still
    // runs on mount, which is the case that matters; only later resizes are
    // missed, and only in environments that cannot resize anyway.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      {...(scrollable && {
        tabIndex: 0,
        role: "group",
        ...(label && { "aria-label": label }),
      })}
      className={cx(
        // Matches the house surface focus ring, so a focused scroller looks like
        // every other focused control rather than like a browser default.
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        className,
      )}
    >
      {children}
    </div>
  );
}
