import Link from "next/link";

/** Server-compatible pagination bar. hrefFor receives a 1-based page number. */
export function Pagination({
  page,
  pageCount,
  hrefFor,
}: {
  page: number;
  pageCount: number;
  hrefFor: (page: number) => string;
}) {
  if (pageCount <= 1) return null;

  const hasPrev = page > 1;
  const hasNext = page < pageCount;

  const linkBase =
    "inline-flex items-center rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-foreground-soft hover:bg-muted transition-colors";
  const disabledBase =
    "inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-subtle-foreground cursor-default";

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="text-sm text-muted-foreground">
        Page {page} of {pageCount}
      </span>
      <div className="flex items-center gap-2">
        {hasPrev ? (
          <Link href={hrefFor(page - 1)} className={linkBase}>
            Prev
          </Link>
        ) : (
          <span className={disabledBase}>Prev</span>
        )}
        {hasNext ? (
          <Link href={hrefFor(page + 1)} className={linkBase}>
            Next
          </Link>
        ) : (
          <span className={disabledBase}>Next</span>
        )}
      </div>
    </div>
  );
}
