import type { ComponentProps } from "react";
import { cx } from "./cx";

/**
 * Brand-tinted checkbox with the same visible focus ring as Input/Select, so
 * keyboard users get a consistent focus affordance across all form controls.
 */
export function Checkbox({ className, ...rest }: ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      {...rest}
      className={cx(
        "h-4 w-4 rounded border-border-strong text-brand accent-brand cursor-pointer",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className,
      )}
    />
  );
}
