/**
 * The schedule toolbars' View selector: an eyebrow over a row of view links.
 *
 * Both schedule builders offer the same control, and until this file existed
 * they offered it as two byte-identical copies (BuilderToolbar's three views,
 * AttendingToolbar's two). Nobody sees the drift, because nobody is on
 * /schedule/builder and /schedule/attendings at once -- which is exactly why
 * the copies would have drifted quietly. One owner instead.
 *
 * ## Why this is not TabRow
 *
 * `TabRow variant="segmented"` is the app's other row-of-links shape, and it is
 * the wrong one here on two counts. Its track is `bg-muted`, and both toolbars
 * ARE a `bg-muted` panel, so the tray would have nothing to read against. And
 * its links are `px-3 py-1.5` with no minimum height, which would drop this
 * control from a 44px touch target to about 30px. The brand fill and the
 * `min-h-11` below are the two things to preserve if this ever moves.
 *
 * ## Why the labels and hrefs are load-bearing
 *
 * e2e/schedule.spec.ts:618, :651, :672 and :795 drive these links with
 * `getByRole("link", { name: "Grid", exact: true })` and the same for "Day".
 * The accessible name is the visible text because nothing here sets an
 * aria-label on a link; adding one (a count badge, say) renames the link and
 * takes those four specs down with it.
 *
 * Server component: no "use client" directive.
 */

import Link from "next/link";
import { cx } from "@/platform/ui/cx";

export type ViewOption<V extends string> = { value: V; label: string };

export function ViewSwitcher<V extends string>({
  options,
  current,
  hrefFor,
}: {
  options: ReadonlyArray<ViewOption<V>>;
  current: V;
  /** Deterministic on the caller's own params, so `current` alone decides active. */
  hrefFor: (value: V) => string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">View</span>
      <nav aria-label="View" className="inline-flex overflow-hidden rounded-lg border border-border bg-surface">
        {options.map(({ value, label }) => (
          <Link
            key={value}
            href={hrefFor(value)}
            aria-current={current === value ? "page" : undefined}
            className={cx(
              "inline-flex items-center min-h-11 px-3 py-1.5 text-sm font-medium transition-colors border-l border-border first:border-l-0",
              current === value ? "bg-brand text-white" : "text-muted-foreground hover:text-foreground-soft",
            )}
          >
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
