import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { cardClasses } from "./card";
import { cx } from "./cx";
import { LinkPendingReporter, PendingDim } from "./list-pending";

/**
 * Scrollable container card wrapping the table element.
 *
 * The container is a PendingDim, so every table in the app fades and stops
 * taking clicks while a `?`-only navigation (filter, page, term switch) is in
 * flight. Those navigations do not remount a Suspense boundary, so loading.tsx
 * never fires and the rows would otherwise sit looking current while the server
 * re-queries.
 *
 * Dimming EVERY table on the page, not just the paginated one, is deliberate: a
 * search-param change re-renders the whole server page, so all of its
 * server-rendered content is equally stale.
 *
 * PendingDim is a client component and this stays a server one. That is not
 * incidental: SortableTH takes an `hrefFor` FUNCTION prop from server pages, and
 * functions cannot cross a server/client boundary, so table.tsx must never gain
 * "use client". Rendering a client wrapper around server children is fine.
 */
export function Table({ className, ...rest }: ComponentProps<"table">) {
  return (
    <PendingDim className={cx(cardClasses({ pad: false }), "overflow-x-auto")}>
      <table
        {...rest}
        className={cx("w-full text-sm", className)}
      />
    </PendingDim>
  );
}

/**
 * The header's background and its ink, named and exported so theme-contrast.test.ts
 * can assert it is still guarding the pair this component actually renders. Audit 14
 * found this exact pair failing WCAG AA in dark mode (3.74:1) across every table in
 * the app; a rename or a repaint that slipped past the guard would put it straight
 * back, silently.
 */
export const THEAD_BG_CLASS = "bg-muted";
export const TH_TEXT_CLASS = "text-subtle-foreground";

export function THead({ className, ...rest }: ComponentProps<"thead">) {
  return <thead {...rest} className={cx(THEAD_BG_CLASS, className)} />;
}

export function TR({ className, ...rest }: ComponentProps<"tr">) {
  return (
    <tr {...rest} className={cx("border-t border-border-subtle", className)} />
  );
}

/** Shared by TH and SortableTH so a sortable header is visually identical to a
 *  plain one apart from its affordance. */
const thClasses = `px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wider ${TH_TEXT_CLASS}`;

export function TH({ className, ...rest }: ComponentProps<"th">) {
  return <th scope="col" {...rest} className={cx(thClasses, className)} />;
}

/** A column header that links to the same page sorted by its column. Renders as
 *  a Link rather than a button so the table stays usable from a server component
 *  with no client JavaScript, and so a sorted view is shareable. */
export function SortableTH<K extends string>({
  columnKey,
  active,
  hrefFor,
  children,
  className,
}: {
  columnKey: K;
  active: { key: K; dir: "asc" | "desc" } | null;
  hrefFor: (key: K) => string;
  children: ReactNode;
  className?: string;
}) {
  const dir = active?.key === columnKey ? active.dir : null;
  const Icon = dir === "asc" ? ChevronUp : dir === "desc" ? ChevronDown : ChevronsUpDown;
  return (
    <th
      scope="col"
      {...(dir && { "aria-sort": dir === "asc" ? ("ascending" as const) : ("descending" as const) })}
      className={cx(thClasses, className)}
    >
      <Link
        href={hrefFor(columnKey)}
        className={cx(
          // Negative margin plus matching padding expands the link over the th's
          // padding, so the whole header cell is one click target.
          "-m-3 inline-flex items-center gap-1 p-3 transition-colors hover:text-foreground",
          dir && "text-foreground",
        )}
      >
        {children}
        <Icon aria-hidden className={cx("h-3.5 w-3.5", !dir && "opacity-40")} />
        <LinkPendingReporter />
      </Link>
    </th>
  );
}

export function TD({ className, ...rest }: ComponentProps<"td">) {
  return (
    <td {...rest} className={cx("px-3 py-2.5", className)} />
  );
}
