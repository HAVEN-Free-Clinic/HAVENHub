import type { ReactNode } from "react";
import Link from "next/link";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

type Tone = "default" | "brand" | "success" | "warning" | "critical";

const valueTone: Record<Tone, string> = {
  default: "text-slate-900",
  brand: "text-brand",
  success: "text-success",
  warning: "text-warning",
  critical: "text-critical",
};

type StatCardProps = {
  label: string;
  /** Prominent figure. Numbers are localized; omit to render a label + children card. */
  value?: string | number;
  /** When set the card becomes a focusable link with hover affordance. */
  href?: string;
  tone?: Tone;
  children?: ReactNode;
};

/**
 * Dashboard metric card: a big value over an uppercase label, optionally
 * linked. Replaces the several hand-rolled stat-card variants across the app.
 */
export function StatCard({ label, value, href, tone = "default", children }: StatCardProps) {
  const body = (
    <>
      {value !== undefined && (
        <p className={cx("text-2xl font-semibold", valueTone[tone])}>
          {typeof value === "number" ? value.toLocaleString() : value}
        </p>
      )}
      <p
        className={cx(
          "text-xs uppercase tracking-wider text-slate-400",
          value !== undefined && "mt-1",
        )}
      >
        {label}
      </p>
      {children}
    </>
  );

  const base = "block rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";

  if (href) {
    return (
      <Link
        href={href}
        className={cx(
          base,
          "transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        )}
      >
        {body}
      </Link>
    );
  }

  return <div className={base}>{body}</div>;
}
