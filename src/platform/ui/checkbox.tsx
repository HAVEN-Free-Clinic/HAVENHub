import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

/**
 * Brand-tinted checkbox with the same visible focus ring as Input/Select, so
 * keyboard users get a consistent focus affordance across all form controls.
 *
 * Pass `label` for the common case of a checkbox with text beside it. Without
 * it, 73 call sites hand-built that row in about a dozen class recipes, the two
 * commonest differing only in ink token, so checkbox rows sat at different type
 * weights on settings screens a director crosses in one session. Wrapping in a
 * `<label>` also associates the text with the control, which a bare adjacent
 * `<span>` does not.
 *
 * Mirrors `Radio` deliberately: same wrapper classes, same `label` prop, same
 * optional `hint`. The two controls appear side by side often enough that any
 * divergence between them reads as a bug.
 */
export function Checkbox({
  label,
  hint,
  className,
  ...rest
}: { label?: ReactNode; hint?: ReactNode } & ComponentProps<"input">) {
  const input = (
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

  // Unlabelled: return the bare control, so the ~20 sites that put a checkbox in
  // a table cell or compose their own row keep working unchanged.
  if (label == null) return input;

  // items-start, not items-center, once a hint is present: a wrapping hint would
  // otherwise drag the box down to the vertical middle of a two-line block.
  //
  // min-h-11 (44px) with a little vertical padding: the label row was ~20px
  // tall, under WCAG 2.2 SC 2.5.8's 24px floor, and these stack in dense
  // columns -- a department scope list, a notification-preference list -- where
  // a mis-tap sets the neighbouring option rather than missing. The whole row is
  // the target because the <label> wraps the box and its text, so the height
  // buys real hit area rather than whitespace.
  //
  // -my-1 keeps the visual rhythm: the padding grows the touch target without
  // pushing the rows apart, the same trick wizard-review.tsx and
  // subject-picker.tsx use on their small controls.
  return (
    <label
      className={cx(
        "-my-1 flex min-h-11 gap-2 py-1 text-sm",
        hint == null ? "items-center" : "items-start",
      )}
    >
      {hint == null ? input : <span className="mt-0.5 flex">{input}</span>}
      <span>
        {label}
        {hint != null && (
          <span className="mt-0.5 block text-xs text-subtle-foreground">{hint}</span>
        )}
      </span>
    </label>
  );
}
