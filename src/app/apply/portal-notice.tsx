import type { ReactNode } from "react";
import { CheckCircle2, Clock, Info, XCircle, type LucideIcon } from "lucide-react";
import { cx } from "@/platform/ui/cx";

type NoticeTone = "success" | "info" | "neutral" | "error";

const toneConfig: Record<NoticeTone, { Icon: LucideIcon; badge: string }> = {
  success: { Icon: CheckCircle2, badge: "bg-success/10 text-success" },
  info: { Icon: Clock, badge: "bg-brand-faint text-brand-fg" },
  neutral: { Icon: Info, badge: "bg-brand-faint text-brand-fg" },
  error: { Icon: XCircle, badge: "bg-critical/10 text-critical" },
};

/**
 * A branded terminal / empty state for the public application portal: a tinted
 * status badge, a short title, supporting copy, and an optional next action.
 * Used for every dead end (closed, submitted, received, errored, nothing open)
 * so none of them fall back to raw centered text. Presentational and client-safe
 * so both server pages and the client error boundary can render it.
 */
export function PortalNotice({
  tone = "info",
  title,
  titleAs: Heading = "h1",
  children,
  action,
  className,
}: {
  tone?: NoticeTone;
  title: string;
  /** Heading level. Defaults to h1 for full-page states; use h2 when a page heading already exists. */
  titleAs?: "h1" | "h2";
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { Icon, badge } = toneConfig[tone];
  return (
    <div className={cx("mx-auto max-w-md py-6 text-center", className)}>
      <span className={cx("mx-auto flex h-12 w-12 items-center justify-center rounded-full", badge)}>
        <Icon className="h-6 w-6" aria-hidden="true" />
      </span>
      <Heading className="mt-5 text-xl font-semibold tracking-tight text-foreground">{title}</Heading>
      {children && (
        <div className="mt-2 text-sm text-muted-foreground [&_p+p]:mt-2">{children}</div>
      )}
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}
