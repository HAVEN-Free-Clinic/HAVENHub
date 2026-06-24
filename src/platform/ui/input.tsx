import type { ComponentProps, ReactNode } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

const controlBase =
  "rounded-lg border border-border-strong px-3 py-2 text-sm w-full outline-none " +
  "focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15 " +
  "disabled:opacity-50 disabled:bg-muted";

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
 * caller — this keeps Field usable from both server and client components.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {children}
      </label>
      {hint && <p className="text-xs text-subtle-foreground">{hint}</p>}
    </div>
  );
}
