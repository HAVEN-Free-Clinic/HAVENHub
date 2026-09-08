import type { ReactNode } from "react";
import { cx } from "./cx";
import { PendingDim } from "./list-pending";

/**
 * The scroll shell for a person-by-date matrix.
 *
 * Three grids (the schedule builder, the attending schedule, the attending
 * coverage view) hand-rolled this container, and all three missed the thing
 * `Table` supplies: `PendingDim`. So every ordinary table in the app fades and
 * stops taking clicks while a `?`-only navigation re-queries the server, and
 * these three sat looking current through a term switch or a week change. A
 * `?`-only navigation never remounts a Suspense boundary, so loading.tsx does
 * not fire and nothing else marks the rows stale.
 *
 * This is the shell only. The three grids differ enormously inside (drag and
 * drop, per-cell state, sticky header rows), and flattening them into one
 * `columns`/`renderCell` abstraction would take slots for nearly everything and
 * share almost nothing. What they genuinely have in common is the box.
 *
 * ## Tone is a prop, not a className
 *
 * Two of the three tint the frame when the grid is in a special mode (a shadow
 * roster, an on-call week). With no tailwind-merge in this repo, passing
 * `border-warning` alongside a base `border-border` is emission-order
 * unreliable, so the shell owns both and the caller picks one.
 *
 * The class list mirrors `cardClasses({ pad: false })` with that tone slot cut
 * into it, rather than calling it and overriding, for the same reason.
 */

const TONE = {
  default: "border-border bg-surface",
  /** A shadow roster or an on-call week: the frame carries the warning. */
  warning: "border-warning bg-warning/5",
} as const;

export type MatrixTone = keyof typeof TONE;

export function MatrixScroll({
  tone = "default",
  capHeight = false,
  children,
}: {
  tone?: MatrixTone;
  /**
   * Bound the height and scroll both axes. Required when the grid pins its
   * header ROW as well as its first column: `position: sticky` resolves against
   * the nearest scrollport, so a header pinned to the top of a table that never
   * scrolls internally simply never engages.
   */
  capHeight?: boolean;
  children: ReactNode;
}) {
  return (
    <PendingDim
      className={cx(
        "rounded-2xl border shadow-sm",
        TONE[tone],
        capHeight ? "max-h-[70vh] overflow-auto" : "overflow-x-auto",
      )}
    >
      {children}
    </PendingDim>
  );
}
