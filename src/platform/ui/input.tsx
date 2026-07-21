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
 */
export function Field({
  label,
  hint,
  hintPosition = "bottom",
  required,
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
  children: ReactNode;
}) {
  const hintId = hint
    ? `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-hint`
    : undefined;

  let control = children;
  if (isValidElement(children) && (hintId || required)) {
    const props = children.props as { "aria-describedby"?: string };
    const describedBy = [hintId, props["aria-describedby"]].filter(Boolean).join(" ") || undefined;
    control = cloneElement(children as ReactElement<Record<string, unknown>>, {
      ...(describedBy ? { "aria-describedby": describedBy } : {}),
      ...(required ? { "aria-required": true } : {}),
    });
  }

  // A top hint renders inside the wrapping <label>, so it's a block <span>
  // (phrasing content, valid inside <label>) rather than a <p>. A bottom hint
  // sits outside the label and stays a <p>.
  const topHint =
    hint && hintPosition === "top" ? (
      <span id={hintId} className="block text-xs text-subtle-foreground">
        {hint}
      </span>
    ) : null;
  const bottomHint =
    hint && hintPosition === "bottom" ? (
      <p id={hintId} className="text-xs text-subtle-foreground">
        {hint}
      </p>
    ) : null;

  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
          {required && <span className="text-critical" aria-hidden="true"> *</span>}
        </span>
        {topHint}
        {control}
      </label>
      {bottomHint}
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
