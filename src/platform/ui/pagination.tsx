import Link from "next/link";
import { pageHref, type PageParams } from "@/platform/lists/page-href";
import { LinkPendingReporter, PendingDim } from "./list-pending";

/**
 * Server-compatible pagination bar.
 *
 * Two ways to say where a page link goes, and exactly one of them per call:
 *
 *  - `basePath` + `params`: hand it the list's own path and the searchParams it
 *    was rendered with, and it builds the links. Prefer this. Eleven lists each
 *    hand-wrote the same URLSearchParams loop, re-listing their own filters, so
 *    adding a filter to a list meant remembering to add it to its pager too.
 *    See pageHref for exactly what it keeps and what it drops -- notably, the
 *    one-shot `error`/`ok`/`message` flash params are stripped, so a toast from
 *    a save does not re-fire on every Next click.
 *  - `hrefFor`: the escape hatch, for a list whose page links come out of a
 *    builder it shares with something else (the recruitment roster's sort
 *    headers, the master roster's sort headers). Routing those through here
 *    would fork that builder rather than retire it.
 *
 * `params` is plain data, so it crosses the RSC boundary; `hrefFor` is a
 * function and cannot, which is why the declarative form is the better default
 * and why this file must stay a server component.
 */
type PaginationProps = { page: number; pageCount: number } & (
  | { hrefFor: (page: number) => string; basePath?: never; params?: never }
  | { basePath: string; params: PageParams; hrefFor?: never }
);

export function Pagination(props: PaginationProps) {
  const { page, pageCount } = props;
  if (pageCount <= 1) return null;

  // Narrowed rather than defaulted: the union guarantees one form or the other,
  // so neither branch needs a fallback value that could never be right.
  const href = props.hrefFor
    ? props.hrefFor
    : (target: number) => pageHref(props.basePath, props.params, target);

  const hasPrev = page > 1;
  const hasNext = page < pageCount;

  const linkBase =
    "inline-flex items-center rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-foreground-soft hover:bg-muted transition-colors";
  const disabledBase =
    "inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-subtle-foreground cursor-default";

  // Dimmed along with the rows, which is what stops a second click queueing
  // another navigation on top of the first.
  return (
    <PendingDim className="flex items-center justify-between gap-4 py-3">
      <span className="text-sm text-muted-foreground">
        Page {page} of {pageCount}
      </span>
      <div className="flex items-center gap-2">
        {hasPrev ? (
          <Link href={href(page - 1)} className={linkBase}>
            Prev
            <LinkPendingReporter />
          </Link>
        ) : (
          <span className={disabledBase}>Prev</span>
        )}
        {hasNext ? (
          <Link href={href(page + 1)} className={linkBase}>
            Next
            <LinkPendingReporter />
          </Link>
        ) : (
          <span className={disabledBase}>Next</span>
        )}
      </div>
    </PendingDim>
  );
}
