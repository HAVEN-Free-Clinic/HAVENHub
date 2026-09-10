import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

const rowSize = {
  sm: "-my-1 min-h-11 gap-2 py-1 text-sm",
  xs: "-my-0.5 min-h-6 gap-1.5 py-0.5 text-xs",
} as const;

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
 *
 * ## `indeterminate`
 *
 * A select-all box with SOME rows ticked is neither checked nor unchecked, and
 * `indeterminate` is the only way to say so -- it is a DOM property, not an
 * attribute, so it cannot be set in JSX. Two bulk-selection tables rendered
 * `checked={allSelected}` and nothing else, so a partial selection reported
 * "unchecked" to the accessibility tree while rows were plainly selected.
 *
 * Applied through a CALLBACK ref rather than useRef + useEffect, because this
 * file carries no "use client" and is rendered by fifteen server components, so
 * a hook here would break every one of them. A callback ref is not a hook.
 *
 * But a ref is not free in a server render either: React refuses to serialise
 * an attached one at all ("Refs cannot be used in Server Components, nor passed
 * to Client Components"), and attaching this one unconditionally took down
 * every admin page that renders a checkbox. So the ref resolves to undefined
 * unless there is something for it to do -- an `indeterminate` to apply, or a
 * caller's own ref to forward -- and both of those only ever come from a client
 * component.
 */
export function Checkbox({
  label,
  hint,
  indeterminate,
  size = "sm",
  className,
  ref,
  ...rest
}: {
  label?: ReactNode;
  hint?: ReactNode;
  /** Some-but-not-all selected. Wins over `checked` in what the box displays. */
  indeterminate?: boolean;
  /**
   * Row density. `sm` (default) is the 44px member-facing row. `xs` is for a
   * dense director control strip -- the "Show handled" / "Show scored" toggles
   * that sit inline in a modal header, the campaign audience builder's Terms
   * chips -- where a 44px row would restructure the header it sits in. It still
   * clears SC 2.5.8's 24px floor at min-h-6; it is not a smaller default by
   * accident, the same considered trade availability-pill.ts records for its
   * builder pill.
   *
   * Checkbox-only for now because no radio group in the app runs at xs. The day
   * one does, Radio must gain the same prop with the same `Omit` below, and
   * "uses the same row shape as Radio" in checkbox.test.tsx is what stops the
   * two quietly diverging in the meantime.
   */
  size?: keyof typeof rowSize;
  // Omit<..., "size">: ComponentProps<"input"> already declares `size?: number`,
  // and an intersection would collapse the property to `never`, so every
  // size="xs" would be a tsc error. No call site passes a numeric size.
} & Omit<ComponentProps<"input">, "size">) {
  // undefined unless there is work to do. TabRow already relies on this shape
  // (`ref={navRef}` with navRef undefined from its server callers), so a ref
  // prop that resolves to undefined is known to be server-safe here; an
  // attached one is not.
  const attachRef =
    indeterminate === undefined && ref == null
      ? undefined
      : (el: HTMLInputElement | null) => {
          if (el) el.indeterminate = indeterminate ?? false;
          // Forward the caller's own ref, so adding this prop cannot silently
          // steal a ref a call site already depends on.
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        };

  const input = (
    <input
      type="checkbox"
      ref={attachRef}
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
      className={cx("flex", rowSize[size], hint == null ? "items-center" : "items-start")}
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

/**
 * A named group of checkboxes: the shape `RadioGroup` already gives radios.
 *
 * Six lists in the app were a bare run of checkboxes under a `<p>`, a `<span>`,
 * or nothing at all: the EHS department scope, the learning course assignment,
 * the roster-copy "Kinds to copy" pair, the delegation checklist, the Epic
 * member picker. A screen reader reached them and read the options with no idea
 * what question they answered, because a visually adjacent `<p>` associates
 * nothing.
 *
 * A real `<fieldset><legend>`, deliberately, and NOT RadioGroup's
 * `role="group"` + `aria-labelledby`: fieldset/legend is the native shape for a
 * checkbox question and needs no id at all, whereas RadioGroup derives its id
 * from the legend text (radio.tsx) and would emit a DUPLICATE id the moment two
 * groups shared a legend. "Departments" is exactly the legend two of these
 * carry.
 *
 * The `m-0 border-0 p-0` reset mirrors FormSection in form.tsx. Tailwind's
 * preflight already zeroes all three on every element, so they are belt and
 * braces; the legend keeps its own `p-0` for the same reason.
 *
 * The gap between the legend and the first option lives in exactly ONE place,
 * the fieldset's `space-y-2`, and never on the legend as a margin-bottom. Both
 * at once would double it. That single ownership is also what makes this
 * class-for-class identical to the fieldset roster-panel.tsx hand-rolled, so
 * adopting it there is a pure de-duplication with no visual diff.
 *
 * `space-y-2` is unconditional, including when the legend is hidden. This repo
 * is on Tailwind 4, where the utility compiles to
 * `:where(& > :not(:last-child))` with margin-BLOCK-END -- not v3's
 * `> :not([hidden]) ~ :not([hidden])` with margin-top. So the margin lands on
 * every child except the last, which with a hidden legend means it lands on the
 * legend itself, and `sr-only` is position: absolute, so it has no visual
 * effect. Skipping the class there would be guarding against a v3 behaviour
 * this repo does not have.
 *
 * Server-safe: no hook and no ref, because this file carries no "use client"
 * and server components render it (see the Checkbox note above).
 *
 * No `className` prop on purpose. A caller class would fight `space-y-2` and
 * `p-0` on emission order, and this repo has no tailwind-merge. Callers that
 * need layout nest a styled `<div>` as the child.
 */
export function CheckboxGroup({
  legend,
  hideLegend,
  children,
}: {
  legend: string;
  /** Keep the accessible name, drop the visible text. */
  hideLegend?: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset className="m-0 border-0 p-0 space-y-2">
      <legend
        className={cx("p-0", hideLegend ? "sr-only" : "text-xs font-medium text-muted-foreground")}
      >
        {legend}
      </legend>
      {children}
    </fieldset>
  );
}
