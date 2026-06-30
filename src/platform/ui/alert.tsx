import type { ComponentProps } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cx } from "./cx";

type Tone = "error" | "success" | "warning" | "info";

const toneIcon: Record<Tone, LucideIcon> = {
  error: XCircle,
  success: CheckCircle2,
  warning: AlertTriangle,
  info: Info,
};

const iconColor: Record<Tone, string> = {
  error: "text-critical",
  success: "text-success",
  warning: "text-warning",
  info: "text-brand-fg",
};

type AlertProps = ComponentProps<"p"> & {
  tone?: Tone;
};

/**
 * Inline status message shown near a form or action.
 *
 * Sizes to its content — a short confirmation stays a compact chip, while a long
 * message grows to the container width and wraps. Color lives in the leading
 * tone icon, not a filled banner, so confirmations stay quiet and transient.
 *
 * Errors announce as role="alert" (assertive); successes/info/warnings announce
 * as role="status" (polite) so meaning isn't conveyed by color alone.
 * Callers may override `role` for non-default behavior.
 */
export function Alert({
  tone = "info",
  className,
  role,
  children,
  ...rest
}: AlertProps) {
  const Icon = toneIcon[tone];
  return (
    <p
      role={role ?? (tone === "error" ? "alert" : "status")}
      {...rest}
      className={cx(
        "flex w-fit max-w-full items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground",
        className,
      )}
    >
      <Icon
        className={cx("mt-px h-4 w-4 shrink-0", iconColor[tone])}
        aria-hidden
      />
      <span>{children}</span>
    </p>
  );
}
