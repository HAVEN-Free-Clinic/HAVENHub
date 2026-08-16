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

type AlertProps = ComponentProps<"div"> & {
  tone?: Tone;
};

/**
 * Inline status message shown near a form or action.
 *
 * Sizes to its content: a short confirmation stays a compact chip, while a long
 * message grows to the container width and wraps. Color lives in the leading
 * tone icon, not a filled banner, so confirmations stay quiet and transient.
 *
 * Errors announce as role="alert" (assertive); successes/info/warnings announce
 * as role="status" (polite) so meaning isn't conveyed by color alone.
 * Callers may override `role` for non-default behavior.
 *
 * Renders a <div>, not a <p> (audit 14). A <p> is auto-closed by the HTML parser
 * the moment a block child opens, so callers that pass a heading line plus detail
 * lines (the do-not-rehire notices) or a copy-the-link row (the interview invite
 * panel) had their content hoisted OUT of the alert: the bordered box rendered
 * empty and its text spilled below it, unstyled and no longer announced with the
 * message. A <div> legally contains both phrasing and flow content, so a caller
 * can pass either without the markup silently coming apart.
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
    <div
      role={role ?? (tone === "error" ? "alert" : "status")}
      {...rest}
      className={cx(
        "flex w-fit max-w-full items-start gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground",
        className,
      )}
    >
      <Icon
        className={cx("mt-px h-4 w-4 shrink-0", iconColor[tone])}
        aria-hidden
      />
      {/* Also a <div>: a block child inside a <span> is the same invalid nesting
          one level down, and min-w-0 keeps a long unbroken message from pushing
          the flex row wider than its container instead of wrapping. */}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
