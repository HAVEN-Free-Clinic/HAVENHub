import type { ComponentProps } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

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
export function cardClasses({
  size = "default",
  pad = true,
  interactive = false,
}: { size?: CardSize; pad?: boolean; interactive?: boolean } = {}): string {
  return cx(
    "border border-border bg-surface",
    size === "compact" ? "rounded-xl" : "rounded-2xl shadow-sm",
    pad && (size === "compact" ? "p-3" : "p-5"),
    interactive && interactiveClasses,
  );
}

type CardProps = ComponentProps<"div"> & {
  /** Surface size. Default is the 16px content card; compact is a 12px dense surface. */
  size?: CardSize;
  /** Adds the hover-lift used on clickable tiles (translateY + stronger shadow/border). */
  interactive?: boolean;
  /** Toggles the default inset (p-5 default, p-3 compact). Set false to manage padding via className. */
  pad?: boolean;
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
