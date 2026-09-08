import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

/**
 * Brand-tinted radio with the same visible focus ring as Checkbox, so keyboard
 * users get a consistent focus affordance across all form controls.
 */
export function Radio({
  label,
  className,
  ...rest
}: { label?: ReactNode } & ComponentProps<"input">) {
  // Same row shape as Checkbox, including the 44px touch target: the two sit
  // side by side often enough that any difference reads as a bug, and
  // checkbox.test.tsx asserts they do not diverge.
  return (
    <label className="-my-1 flex min-h-11 items-center gap-2 py-1 text-sm">
      <input
        type="radio"
        {...rest}
        className={cx(
          "h-4 w-4 border-border-strong text-brand accent-brand cursor-pointer",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          className,
        )}
      />
      {label != null && <span>{label}</span>}
    </label>
  );
}

/**
 * A named group of radios.
 *
 * `role="radiogroup"` is an ARIA group, and an ARIA group with no accessible
 * name is announced as an anonymous one -- so a screen reader said "radio
 * group" and then read the options with no idea what question they answered.
 * The `legend` was rendered as a bare span: visible, and invisible to AT.
 *
 * Wiring it through `aria-labelledby` (rather than switching to
 * fieldset/legend) keeps the existing markup and styling and fixes both
 * legend-bearing call sites at once.
 *
 * The id is derived from the legend text rather than from `useId`, because this
 * file carries no "use client" and one of the two call sites is a server
 * component -- `useId` is a hook and would throw there. `Field` in input.tsx
 * derives its hint id the same way for the same reason.
 *
 * A group with no `legend` is left unnamed on purpose: those two sit inside a
 * FormSection, which is already a real fieldset with a real legend, and naming
 * the inner group as well would make AT announce the question twice.
 */
export function RadioGroup({
  legend,
  children,
  className,
}: {
  legend?: string;
  children: ReactNode;
  className?: string;
}) {
  const legendId = legend
    ? `radiogroup-${legend.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`
    : undefined;
  return (
    <div
      role="radiogroup"
      aria-labelledby={legendId}
      className={cx("flex flex-col gap-2", className)}
    >
      {legend && (
        <span id={legendId} className="text-xs font-medium text-muted-foreground">
          {legend}
        </span>
      )}
      {children}
    </div>
  );
}
