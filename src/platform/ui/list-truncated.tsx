/**
 * "Showing the first N of M" -- the one sentence a capped list owes its reader.
 *
 * Three lists said it, in two sizes and two ink tokens, and two of the three
 * printed the total as a bare integer: "Showing the first 50 of 1284". The
 * result count on every filter row already learned this lesson (see
 * filter-bar.tsx), and a truncation notice is the place a large number is most
 * likely to appear.
 *
 * ## Why the hint is a prop
 *
 * The two situations are genuinely different, and the difference is what the
 * reader needs to know:
 *
 * - A SEARCH that matched more than it will show. The reader can act: narrow it.
 * - A PREVIEW sample of an audience. The reader must not narrow anything -- the
 *   count beside it is exact and the sample is illustrative -- so the hint says
 *   so instead.
 *
 * Fixing one sentence for both would have to be vague enough to cover both,
 * which is how a notice ends up saying nothing.
 */
export function ListTruncated({
  shown,
  total,
  hint,
}: {
  /** How many rows are actually on the page. */
  shown: number;
  /** How many there are. Always rendered with a thousands separator. */
  total: number;
  /** What the reader can do about it, or why they need not. */
  hint?: string;
}) {
  return (
    <p className="text-xs text-muted-foreground">
      Showing the first {shown.toLocaleString()} of {total.toLocaleString()}.
      {hint ? ` ${hint}` : ""}
    </p>
  );
}
