import type { ComponentProps } from "react";
import { cx } from "./cx";

type Tone = "default" | "brand" | "success" | "warning" | "critical";

/**
 * Tone → status dot color. The chip itself stays neutral; color is carried by a
 * small leading dot so different statuses read as the same kind of object with a
 * precise accent, rather than a row of variously-tinted pills. `default` shows no
 * dot — it's a plain categorical label.
 */
const dotClasses: Record<Tone, string | null> = {
  default: null,
  brand: "bg-brand",
  success: "bg-success",
  warning: "bg-warning",
  critical: "bg-critical",
};

type BadgeProps = ComponentProps<"span"> & {
  tone?: Tone;
};

export function Badge({ tone = "default", className, children, ...rest }: BadgeProps) {
  const dot = dotClasses[tone];
  return (
    <span
      {...rest}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground-soft",
        className,
      )}
    >
      {dot && (
        <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", dot)} aria-hidden />
      )}
      {children}
    </span>
  );
}
