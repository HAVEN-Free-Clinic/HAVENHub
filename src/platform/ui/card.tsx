import type { ComponentProps } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

const base = "rounded-2xl border border-slate-200 bg-white shadow-sm";
const interactiveClasses =
  "transition-[transform,box-shadow,border-color] duration-150 " +
  "hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md";

type CardProps = ComponentProps<"div"> & {
  /** Adds the hover-lift used on clickable tiles (translateY + stronger shadow/border). */
  interactive?: boolean;
  /** Toggles the default 20px inset. Set false for cards that manage their own padding. */
  pad?: boolean;
};

/**
 * The atomic surface container: white, 1px slate-200 hairline, 16px radius, soft
 * shadow. This is the canonical card — prefer it over hand-rolling
 * `rounded-2xl border bg-white` so the radius/shadow/border stay consistent app-wide.
 */
export function Card({ interactive = false, pad = true, className, ...rest }: CardProps) {
  return (
    <div
      {...rest}
      className={cx(base, pad && "p-5", interactive && interactiveClasses, className)}
    />
  );
}
