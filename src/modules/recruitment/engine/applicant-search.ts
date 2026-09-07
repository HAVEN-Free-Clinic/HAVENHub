/**
 * The applicant roster's name search.
 *
 * Matches against name AND email, because an email address is what a reviewer
 * actually has in hand: these searches start from a message someone forwarded,
 * and pasting the address is faster and less ambiguous than retyping a name.
 *
 * Every whitespace-separated term must match somewhere, so "doe jane" finds Jane
 * Doe just as "jane doe" does, and a partial term is enough ("jan" finds Jane).
 * Requiring all terms is what makes a second word narrow the list rather than
 * widen it, which is what someone typing a full name expects.
 *
 * Accents are folded, so "jose" finds "José". Names in this roster are typed by
 * the applicants themselves and searched by someone who may only have heard
 * them; an accent the searcher cannot produce must not hide a row.
 */

export type SearchableApplicant = {
  applicant: { firstName: string; lastName: string; email: string };
};

/** Lowercased and accent-free, the form both sides of the comparison take. */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * The query as the filter uses it, or null for "no search".
 *
 * Whitespace-only input is null rather than a term that matches everything, so a
 * stray space in the URL does not read as a filter that happens to match all
 * rows: the roster must say "no filter" in that case, not "every row matched".
 */
export function normalizeApplicantQuery(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Narrows a roster to rows matching every term in the query. A null query means
 *  no filter. */
export function filterApplicantsByQuery<T extends SearchableApplicant>(
  apps: T[],
  query: string | null,
): T[] {
  if (!query) return apps;
  const terms = fold(query).split(/\s+/).filter((t) => t !== "");
  if (terms.length === 0) return apps;
  return apps.filter((a) => {
    const haystack = fold(`${a.applicant.firstName} ${a.applicant.lastName} ${a.applicant.email}`);
    return terms.every((t) => haystack.includes(t));
  });
}
