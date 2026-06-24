import type { ComponentProps } from "react";

type Tone = "default" | "brand" | "success" | "warning" | "critical";

const toneClasses: Record<Tone, string> = {
  default:  "bg-muted-strong text-foreground-soft",
  brand:    "bg-brand-faint text-brand-fg",
  success:  "bg-green-50 text-success",
  warning:  "bg-amber-50 text-warning",
  critical: "bg-red-50 text-critical",
};

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

type BadgeProps = ComponentProps<"span"> & {
  tone?: Tone;
};

export function Badge({ tone = "default", className, ...rest }: BadgeProps) {
  return (
    <span
      {...rest}
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        toneClasses[tone],
        className,
      )}
    />
  );
}
