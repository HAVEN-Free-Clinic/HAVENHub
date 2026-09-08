"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";

/**
 * Fades the edge of a horizontally scrolling strip that has more to show.
 *
 * The tab rows hide their scrollbar on purpose ("[scrollbar-width:none]"), which
 * looks right on a laptop where every tab fits and is a trap on a phone: a
 * director opening a recruitment cycle sees roughly three of thirteen tabs with
 * no scrollbar, no fade and no chevron to say the other ten exist. The auto
 * scroll-into-view of the active tab makes it worse, because the row arrives
 * already scrolled, so even the first tab may be off-screen to the LEFT.
 *
 * ## Why a mask, and why on the wrapper
 *
 * A gradient overlay would have to know the colour behind it, and these strips
 * sit on two different grounds (the segmented row on `bg-muted`, the underline
 * row on the page canvas). A mask fades whatever is actually painted, so it is
 * background-agnostic and cannot go out of step with a theme change.
 *
 * It goes on this wrapper rather than the strip itself because the strip is the
 * scrollport: anything positioned inside it scrolls away with the content, while
 * the wrapper stays put over the visible window.
 *
 * ## Why not ScrollRegion
 *
 * That primitive adds a tab stop, which is right for a table whose off-screen
 * columns contain nothing focusable. A tab strip is all links: a keyboard user
 * already reaches the off-screen ones by tabbing, and the browser scrolls them
 * into view. What is missing here is only the visual cue, so adding a stop would
 * be an extra stop for nothing.
 */
export function ScrollFade({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const wrap = ref.current;
    const strip = wrap?.firstElementChild as HTMLElement | null;
    if (!strip) return;

    const measure = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      // 1px slack: fractional layout widths otherwise leave a permanent hairline
      // fade on a row that is actually fully visible.
      setEdges({ left: strip.scrollLeft > 1, right: strip.scrollLeft < max - 1 });
    };
    measure();

    strip.addEventListener("scroll", measure, { passive: true });
    // Guarded: jsdom has no ResizeObserver, and a component test that renders a
    // tab row should not throw on it. The mount measurement above still runs.
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(strip);
    }
    return () => {
      strip.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, []);

  // Two edges, four combinations. Spelled out rather than composed, because a
  // mask-image is a single property: a second class would replace the first
  // rather than add to it, and this repo has no tailwind-merge to arbitrate.
  const mask =
    edges.left && edges.right
      ? "[mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-24px),transparent)]"
      : edges.left
        ? "[mask-image:linear-gradient(to_right,transparent,black_24px)]"
        : edges.right
          ? "[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]"
          : undefined;

  return (
    <div ref={ref} className={cx("relative", mask, className)}>
      {children}
    </div>
  );
}
