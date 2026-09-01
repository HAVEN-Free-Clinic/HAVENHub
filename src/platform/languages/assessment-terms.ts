/**
 * Term labels on assessment records, and the sortable key that makes them
 * orderable.
 *
 * The labels are free text ("Spring 2012", "Fall 2026") because they come from a
 * spreadsheet going back to 2012, long before any of these terms existed as Term
 * rows in Hub. That is fine for display and hopeless for ordering: sorting the
 * label as text puts "Summer 2012" ahead of "Fall 2026", because 'S' > 'F'. The
 * profile badge reading `orderBy: { term: "desc" }` to find someone's "most
 * recent" score therefore showed their OLDEST one whenever the seasons happened
 * to sort that way, which is the score a director then staffs a shift on.
 *
 * So every record also carries `termRank`, an integer derived from the label:
 *
 *   year * 10 + season   ->   Spring 2012 = 20121, Fall 2026 = 20263
 *
 * Ordering is always on termRank; the label is only ever displayed. Pure module
 * (no prisma) so the import script, the services, and the tests all share one
 * definition of what a term label means.
 */

/** Calendar order within a year. Hub terms use Spring/Summer/Fall; Winter is accepted for imported rows. */
export const ASSESSMENT_SEASONS = ["Spring", "Summer", "Fall", "Winter"] as const;

export type AssessmentSeason = (typeof ASSESSMENT_SEASONS)[number];

/**
 * Rank given to a label that does not parse. Sorts last under DESC, which is
 * what we want: a malformed label must never win "most recent" over a real term.
 */
export const UNRANKED_TERM = 0;

export type ParsedTerm = { season: AssessmentSeason; year: number };

/** "spring 2012", "Spring  2012" -> { season: "Spring", year: 2012 }. Null when it does not parse. */
export function parseTermLabel(label: string): ParsedTerm | null {
  const match = label.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!match) return null;
  const season = ASSESSMENT_SEASONS.find(
    (s) => s.toLowerCase() === match[1].toLowerCase(),
  );
  if (!season) return null;
  return { season, year: Number(match[2]) };
}

/** The canonical label for a season/year, so imported and hand-entered rows agree on casing. */
export function formatTermLabel(season: AssessmentSeason, year: number): string {
  return `${season} ${year}`;
}

/** The sortable key for a label. UNRANKED_TERM when the label does not parse. */
export function termRankOf(label: string): number {
  const parsed = parseTermLabel(label);
  if (!parsed) return UNRANKED_TERM;
  return parsed.year * 10 + (ASSESSMENT_SEASONS.indexOf(parsed.season) + 1);
}

/** Normalises casing and spacing on a label, leaving anything unparseable alone. */
export function normalizeTermLabel(label: string): string {
  const parsed = parseTermLabel(label);
  return parsed ? formatTermLabel(parsed.season, parsed.year) : label.trim();
}
