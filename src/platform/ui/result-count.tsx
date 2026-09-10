/**
 * How many rows the current filter matched, on the row's trailing edge.
 *
 * The number a manager watches while filtering used to land in a different part
 * of the screen on every list -- the PageHeader description, a `<p>` above the
 * table, the middle of the filter row -- so it moved as they moved between
 * pages. `FilterBar` settled that with a `resultCount` slot, and most lists now
 * pass it. Two rows cannot: the applicants roster and the support request
 * filters build their row out of `FormRow`/`NavForm` directly, because they
 * need per-control behaviour FilterBar does not offer (a nested form so Enter
 * searches without submitting the selects beside it, selects that navigate on
 * change). Both had hand-copied the slot's class string -- and both had dropped
 * the `ml-auto` that puts it on the trailing edge, which is the whole point of
 * the placement.
 *
 * So the slot lives here, and FilterBar renders it too.
 *
 * Its own file rather than an export from filter-bar.tsx: request-filters.tsx is
 * a client component, and importing from filter-bar would pull NavForm and the
 * whole FilterBar into that bundle.
 *
 * No className prop. The trailing edge is the settled placement, and a caller
 * className fighting `ml-auto` is exactly the emission-order coin-flip this repo
 * has no tailwind-merge to resolve.
 */
export function ResultCount({
  total,
  noun,
  pluralNoun,
}: {
  total: number;
  /** Singular. "member", "entry", "request". */
  noun: string;
  /** For irregulars: "entries", "people". Defaults to `noun` + "s". */
  pluralNoun?: string;
}) {
  return (
    // ml-auto, so the count sits on the trailing edge however many controls
    // precede it. pb-2 lines its baseline up with the labelled fields beside it
    // rather than with the buttons.
    <span className="ml-auto pb-2 text-sm whitespace-nowrap text-muted-foreground">
      {/* Always a thousands separator: two queues were printing bare integers. */}
      {total.toLocaleString()} {total === 1 ? noun : (pluralNoun ?? `${noun}s`)}
    </span>
  );
}
