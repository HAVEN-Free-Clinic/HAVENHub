import type { NavModule } from "@/platform/modules/nav";

/** One page result. `group` is the owning module title, for section headers. */
export type PageHit = { label: string; href: string; group: string; score: number };

/**
 * Subsequence match with a tightness score. Returns null when `needle` is not a
 * subsequence of `haystack`; otherwise a score where LOWER is better.
 *
 * The score is the span consumed (last matched index minus first) plus the
 * offset of the first match, so a contiguous prefix beats a scattered match and
 * an early match beats a late one. This is what makes "sch" rank "Schedule"
 * above "Speed check".
 */
export function subsequenceScore(haystack: string, needle: string): number | null {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (n.length === 0) return 0;

  let first = -1;
  let last = -1;
  let hi = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found === -1) return null;
    if (first === -1) first = found;
    last = found;
    hi = found + 1;
  }
  return last - first + first;
}

/**
 * Rank the pages a viewer can open against a query.
 *
 * `items` is the already permission-filtered NavModule list the global nav
 * renders, so this function performs NO access control of its own and cannot
 * surface a page the caller did not supply. Keep it that way: the moment this
 * reaches for the registry directly it becomes a permission bypass.
 */
export function matchPages(items: NavModule[], query: string, limit = 8): PageHit[] {
  const q = query.trim();
  if (q.length === 0) return [];

  const hits: PageHit[] = [];
  const seen = new Set<string>();

  for (const m of items) {
    const candidates = [
      { label: m.title, href: m.href },
      ...m.nav.map((n) => ({ label: n.label, href: n.href })),
    ];
    for (const c of candidates) {
      if (seen.has(c.href)) continue;
      // Match the label first; fall back to "Module label" so typing a module
      // name surfaces its pages.
      const direct = subsequenceScore(c.label, q);
      const viaModule = direct === null ? subsequenceScore(`${m.title} ${c.label}`, q) : null;
      const score = direct ?? viaModule;
      if (score === null) continue;
      seen.add(c.href);
      // A label match outranks a match that only worked via the module name.
      hits.push({ label: c.label, href: c.href, group: m.title, score: direct === null ? score + 100 : score });
    }
  }

  return hits.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label)).slice(0, limit);
}
