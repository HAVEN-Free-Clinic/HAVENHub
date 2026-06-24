import type { ComponentProps } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

type Tone = "error" | "success" | "warning" | "info";

const toneClasses: Record<Tone, string> = {
  error: "border-critical/20 bg-red-50 text-critical",
  success: "border-success/20 bg-green-50 text-success",
  warning: "border-warning/30 bg-amber-50 text-warning",
  info: "border-brand/20 bg-brand-faint text-brand-fg",
};

type AlertProps = ComponentProps<"p"> & {
  tone?: Tone;
};

/**
 * Inline status banner shown near a form or action.
 *
 * Errors announce as role="alert" (assertive); successes/info/warnings announce
 * as role="status" (polite) so confirmations aren't conveyed by color alone.
 * Callers may override `role` for non-default behavior.
 */
export function Alert({ tone = "info", className, role, ...rest }: AlertProps) {
  return (
    <p
      role={role ?? (tone === "error" ? "alert" : "status")}
      {...rest}
      className={cx(
        "rounded-xl border px-3 py-2 text-sm",
        toneClasses[tone],
        className,
      )}
    />
  );
}
