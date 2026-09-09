import { cloneElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { cx } from "./cx";

const controlBase =
  "rounded-lg border border-border-strong px-3 py-2 text-sm w-full outline-none " +
  "focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15 " +
  "disabled:opacity-50 disabled:bg-muted bg-surface";

export function Input({
  className,
  ...rest
}: ComponentProps<"input">) {
  return <input {...rest} className={cx(controlBase, className)} />;
}

export function Textarea({
  className,
  ...rest
}: ComponentProps<"textarea">) {
  return <textarea {...rest} className={cx(controlBase, className)} />;
}

/**
 * Wraps a single form control with a label and optional hint text.
 *
 * The label *wraps* the control (implicit association) so screen readers and
 * label-click focus work without threading an `id`/`htmlFor` pair through every
 * caller; this keeps Field usable from both server and client components.
 *
 * The hint is associated to the control via aria-describedby (id derived from the
 * label, so no hook is needed and server usage still works), and `required`
 * conveys aria-required so the requirement isn't communicated by the `*` alone.
 *
 * ## `error`
 *
 * A validated form has to do three separate things with a message, and doing
 * two of them is the failure mode this slot exists to end:
 *
 *   1. show it,
 *   2. tie it to the control, so it is read on focus (`aria-describedby`) and
 *      the control is marked wrong (`aria-invalid`),
 *   3. ANNOUNCE it when it appears (`role="alert"`), because the reader is not
 *      necessarily on the field that failed -- after a submit they are usually
 *      nowhere near it.
 *
 * The onboarding contract at /onboard/[token] did 1 and 2 by hand, in ten
 * copies, and never did 3. So a newly accepted volunteer whose HIPAA date or
 * Epic ID was rejected got a page that silently re-rendered. The same fields
 * rendered through FieldPreview in the /apply wizard DO announce, so one person
 * got two different behaviours in the two halves of one recruitment flow.
 *
 * The error id is derived from the label like the hint id, so this still needs
 * no hook and still works from a server component. When both are present the
 * control is described by the hint AND the error, in that order: the hint says
 * what the field wants, the error says what went wrong with what you typed, and
 * a reader arriving at a failed field needs both.
 */
export function Field({
  label,
  hint,
  hintPosition = "bottom",
  required,
  error,
  children,
}: {
  label: string;
  hint?: string;
  /**
   * Where the hint sits relative to the control. "bottom" (default) reads as a
   * trailing note; "top" places the guidance between the label and the control
   * so it's seen before the field is filled -- useful when the control itself is
   * tall (e.g. a multi-select box) and a trailing note is easy to miss.
   */
  hintPosition?: "top" | "bottom";
  required?: boolean;
  /** What went wrong with this field. Shown, tied to the control, and announced. */
  error?: ReactNode;
  children: ReactNode;
}) {
  // Prefer the control's own `name`, which is unique within a form; fall back to
  // the label. Two fields CAN share a label -- an onboarding contract renders
  // custom questions an author wrote, and nothing stops two of them saying
  // "Date" -- and a duplicated id makes aria-describedby resolve to whichever
  // came first, quietly describing one field with another's message.
  const controlName = isValidElement(children)
    ? (children.props as { name?: string }).name
    : undefined;
  const slug = (controlName ?? label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  // An error takes the bottom hint's place (see the note by the render), so in
  // that case the hint element does not exist and must not be pointed at:
  // aria-describedby naming a missing id describes the control with nothing.
  const showHint = Boolean(hint) && !(error && hintPosition === "bottom");
  const hintId = showHint ? `field-${slug}-hint` : undefined;
  const errorId = error ? `field-${slug}-error` : undefined;

  let control = children;
  if (isValidElement(children) && (hintId || errorId || required)) {
    const props = children.props as { "aria-describedby"?: string };
    const describedBy =
      [hintId, errorId, props["aria-describedby"]].filter(Boolean).join(" ") || undefined;
    control = cloneElement(children as ReactElement<Record<string, unknown>>, {
      ...(describedBy ? { "aria-describedby": describedBy } : {}),
      ...(required ? { "aria-required": true } : {}),
      // Only ever set true. A bare aria-invalid="false" on every field in the
      // app is noise, and some readers announce it.
      ...(errorId ? { "aria-invalid": true } : {}),
    });
  }

  // A top hint renders inside the wrapping <label>, so it's a block <span>
  // (phrasing content, valid inside <label>) rather than a <p>. A bottom hint
  // sits outside the label and stays a <p>.
  const topHint =
    showHint && hintPosition === "top" ? (
      <span id={hintId} className="block text-xs text-subtle-foreground">
        {hint}
      </span>
    ) : null;
  const bottomHint =
    showHint && hintPosition === "bottom" ? (
      <p id={hintId} className="text-xs text-subtle-foreground">
        {hint}
      </p>
    ) : null;

  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
          {required && <span className="text-critical-foreground" aria-hidden="true"> *</span>}
        </span>
        {topHint}
        {control}
      </label>
      {/* The error replaces the bottom hint rather than stacking under it: the
          two say the same KIND of thing about one small control, and a field
          showing both reads as two competing instructions. A top hint is
          guidance seen before typing and is left in place. */}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-critical-foreground">
          {error}
        </p>
      ) : (
        bottomHint
      )}
    </div>
  );
}

/**
 * Static display row for a non-editable value (IT-managed fields, computed
 * values). Renders as plain text with a hairline underline so it reads as
 * information, not as a disabled input, and is not a tab stop.
 */
export function ReadonlyField({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <p className="min-h-[34px] border-b border-border py-1.5 text-sm font-medium text-foreground">
        {value || (
          <span className="font-normal italic text-subtle-foreground">Not set</span>
        )}
      </p>
      {hint && <p className="text-xs text-subtle-foreground">{hint}</p>}
    </div>
  );
}
