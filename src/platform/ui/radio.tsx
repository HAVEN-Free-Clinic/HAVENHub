import type { ComponentProps, ReactNode } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Brand-tinted radio with the same visible focus ring as Checkbox, so keyboard
 * users get a consistent focus affordance across all form controls.
 */
export function Radio({
  label,
  className,
  ...rest
}: { label?: ReactNode } & ComponentProps<"input">) {
  return (
    <label className="flex items-center gap-2 text-sm">
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

export function RadioGroup({
  legend,
  children,
  className,
}: {
  legend?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div role="radiogroup" className={cx("flex flex-col gap-2", className)}>
      {legend && (
        <span className="text-xs font-medium text-muted-foreground">{legend}</span>
      )}
      {children}
    </div>
  );
}
