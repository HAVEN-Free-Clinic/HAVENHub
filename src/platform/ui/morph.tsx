"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cx } from "./cx";
import { slideDistance, spring, swapBlur } from "./motion";

/**
 * The content height of an element, kept current with a ResizeObserver.
 * `null` until the first measurement, and forever where ResizeObserver does
 * not exist (jsdom), so callers fall back to `height: auto` there.
 */
function useMeasuredHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setHeight(entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, height] as const;
}

/**
 * A container whose height follows its content with the standard spring, so a
 * view that grows or shrinks never snaps. The first measurement does not
 * animate: the box opens at its natural size and only later changes move.
 *
 * The animated height lives on the OUTER element and the measured one is the
 * inner wrapper. Measuring the element being animated would feed each frame's
 * height back into the target and loop.
 *
 * `className` goes on the outer, clipping element (it is where a scroll
 * container's `overflow-auto` belongs); `innerClassName` on the measured one
 * (padding belongs there, so it is counted in the height).
 */
export function MorphHeight({
  children,
  className,
  innerClassName,
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}) {
  const [ref, height] = useMeasuredHeight<HTMLDivElement>();
  return (
    <motion.div
      initial={false}
      animate={{ height: height ?? "auto" }}
      transition={spring.default}
      className={cx("overflow-hidden", className)}
    >
      <div ref={ref} className={innerClassName}>
        {children}
      </div>
    </motion.div>
  );
}

const swapVariants = {
  enter: (direction: 1 | -1) => ({ opacity: 0, x: direction * slideDistance, filter: swapBlur }),
  center: { opacity: 1, x: 0, filter: "blur(0px)" },
  exit: (direction: 1 | -1) => ({ opacity: 0, x: direction * -slideDistance, filter: swapBlur }),
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * One view of a multi-step flow at a time. Changing `viewKey` cross-fades the
 * old view out and the new one in with a light blur, sliding 24px in the
 * direction of travel: forward (1) moves content left, back (-1) moves it right.
 * Wrap it in MorphHeight (Modal's body already is one) and the container
 * resizes to each view as it arrives.
 *
 * The first view does not animate in. Every later swap moves focus to the
 * first focusable control of the new view, so a keyboard user lands in it
 * rather than on a control that just left the DOM.
 *
 * Keep `viewKey` and `direction` in ONE state object and update them together,
 * so a Back click sets direction -1 in the same render as the step change.
 */
export function ViewSwap({
  viewKey,
  direction = 1,
  children,
}: {
  viewKey: string;
  direction?: 1 | -1;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Every view after the first takes focus, including a return to the first.
  // Compared by key rather than a "has mounted" flag, which StrictMode's double
  // effect run would read as a swap.
  const [initialKey] = useState(viewKey);
  const [hasSwapped, setHasSwapped] = useState(false);
  if (viewKey !== initialKey && !hasSwapped) setHasSwapped(true);

  useEffect(() => {
    if (!hasSwapped) return;
    // Found by key, on every key change. Mid-swap both views are in the DOM,
    // and a fast Next-then-Back brings the still-exiting view back WITHOUT
    // remounting it, so neither a shared ref nor a mount effect is reliable.
    const view = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>("[data-view-key]") ?? [],
    ).find((el) => el.dataset.viewKey === viewKey);
    view?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
  }, [viewKey, hasSwapped]);

  // `relative`: popLayout lifts the exiting view out with position: absolute,
  // and it has to stay anchored to this box while it fades.
  return (
    <div ref={containerRef} className="relative">
      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
        <motion.div
          key={viewKey}
          data-view-key={viewKey}
          custom={direction}
          variants={swapVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={spring.default}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
