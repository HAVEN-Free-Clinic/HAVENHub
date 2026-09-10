import type { ComponentProps } from "react";
import { cx } from "./cx";

type CardSize = "default" | "compact";

const interactiveClasses =
  "transition-[transform,box-shadow,border-color] duration-150 " +
  "hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md";

/**
 * Canonical surface classes. `default` is the 16px-radius, soft-shadow content
 * card; `compact` is a 12px-radius, shadowless surface for dense list rows and
 * nested sub-panels. Use this directly on a Link/button/a when the surface must
 * be a clickable element; use the Card component for the common div case.
 */
/**
 * How much room the surface leaves around its content.
 *
 * `"tight"` is the dense panel inset the schedule sidebars use. It is NOT the
 * same axis as `size: "compact"`, which changes the RADIUS -- six panels wanted
 * the tighter inset on a full-radius card and each spelled it out by hand as
 * `cardClasses({ pad: false })} px-4 py-3`.
 */
export type CardPad = boolean | "tight";

export function cardClasses({
  size = "default",
  pad = true,
  interactive = false,
}: { size?: CardSize; pad?: CardPad; interactive?: boolean } = {}): string {
  // An explicit ladder, not `pad && (...)`. "tight" is truthy, so an && chain
  // would fall through to the boolean branch and quietly emit p-5.
  const inset =
    pad === "tight" ? "px-4 py-3" : pad ? (size === "compact" ? "p-3" : "p-5") : false;

  return cx(
    "border border-border bg-surface",
    size === "compact" ? "rounded-xl" : "rounded-2xl shadow-sm",
    inset,
    interactive && interactiveClasses,
  );
}

type CardProps = ComponentProps<"div"> & {
  /** Surface size. Default is the 16px content card; compact is a 12px dense surface. */
  size?: CardSize;
  /** Adds the hover-lift used on clickable tiles (translateY + stronger shadow/border). */
  interactive?: boolean;
  /** The inset: true for the default (p-5, or p-3 when compact), "tight" for the
   *  dense panel inset, false to manage padding via className. */
  pad?: CardPad;
};

/**
 * The atomic surface container. Prefer it (or cardClasses) over hand-rolling
 * rounded-2xl border bg-surface so the radius/shadow/border stay consistent app-wide.
 */
export function Card({ size = "default", interactive = false, pad = true, className, ...rest }: CardProps) {
  return (
    <div {...rest} className={cx(cardClasses({ size, pad, interactive }), className)} />
  );
}
