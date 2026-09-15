import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * The content column under a PageHeader: how wide it is, and how far apart its
 * sections sit.
 *
 * Every page picked its own measure, and the cost is visible where pages sit
 * side by side. One recruitment cycle's tabs ran 42rem, 48rem, 56rem, 72rem and
 * full-bleed, so the content column resized on every tab click -- the same
 * workspace, jumping width as you moved through it.
 *
 * ## The widths encode a rule, not a taste
 *
 * Pick by what the page HOLDS:
 *
 *   form     a single-column form, or a record read top to bottom
 *   content  a long-form editor: a contract, the form builder
 *   wide     dense panels that are still not a full-bleed table
 *   full     tables and grids
 *
 * `full` is not unbounded: AppShell already caps the main column, so this only
 * declines to narrow it further.
 *
 * ## className is for extra outer classes, never a competing measure
 *
 * This repo has no tailwind-merge, so a caller passing its own `max-w-*` or
 * `space-y-*` alongside one of these does not override it -- whichever Tailwind
 * emits later wins, which is not the same thing and not stable. A page that
 * wants a different width wants a different token, or a new one.
 */
type PageBodyWidth = "form" | "content" | "wide" | "full";
type PageBodyGap = "default" | "loose" | "none";

const widthClasses: Record<PageBodyWidth, string> = {
  form: "max-w-2xl",
  content: "max-w-3xl",
  wide: "max-w-4xl",
  // The shell owns the outer bound.
  full: "",
};

const gapClasses: Record<PageBodyGap, string> = {
  default: "space-y-6",
  loose: "space-y-8",
  none: "",
};

export function PageBody({
  width = "full",
  gap = "default",
  className,
  children,
}: {
  width?: PageBodyWidth;
  gap?: PageBodyGap;
  /** Extra outer classes only. Not a width and not a gap: see the note above. */
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx(widthClasses[width], gapClasses[gap], className)}>{children}</div>;
}
