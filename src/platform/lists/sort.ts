/**
 * The generic half of a URL-driven table sort: read the query params, and work
 * out which direction a header click should open in.
 *
 * This lived inside src/modules/recruitment/engine/applicant-sort.ts, next to
 * the recruitment-specific comparators, and module-boundary lint forbids any
 * other module importing from there. So the one list in the app with sortable
 * headers was also the only list that could have them without reinventing this
 * first. It is here, not under platform/ui/, because services import it too and
 * it renders nothing.
 *
 * Deliberately NOT generic over the comparator. Ordering a column is the part
 * that is genuinely per-list (a status column sorts by severity, a name column
 * by surname); only the param handling repeats.
 */

export type SortDirection = "asc" | "desc";

export type Sort<K extends string> = { key: K; dir: SortDirection };

/**
 * Reads a list's `sort`/`dir` query params against the keys that list allows.
 *
 * Returns null for anything unrecognised -- an unknown key, a missing or
 * garbage direction -- so a hand-edited or stale URL falls back to the list's
 * default order instead of erroring or sorting on a column that no longer
 * exists.
 */
export function parseSort<K extends string>(
  sort: string | undefined,
  dir: string | undefined,
  allowed: readonly K[],
): Sort<K> | null {
  if (!sort || !(allowed as readonly string[]).includes(sort)) return null;
  if (dir !== "asc" && dir !== "desc") return null;
  return { key: sort as K, dir };
}

/**
 * Two-state toggle for a header link: re-clicking the active column flips it, a
 * new column opens in that column's own default direction.
 *
 * The defaults matter per column, not per list: a name column wants ascending,
 * a score column wants "who is highest" and so opens descending.
 */
export function nextDirection<K extends string>(
  current: Sort<K> | null,
  key: K,
  defaults: Record<K, SortDirection>,
): SortDirection {
  if (current?.key === key) return current.dir === "asc" ? "desc" : "asc";
  return defaults[key];
}
