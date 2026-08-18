/**
 * Deriving the name to greet someone by, from the single free-text `Person.name`
 * column.
 *
 * `Person` stores ONE name string: there is no first/last/preferred split, and
 * no nickname field. Every greeting surface (the dashboard, the apply portal,
 * the onboarding gate, and every email that opens "Hi {{ firstName }}") used to
 * reimplement `name.trim().split(/\s+/)[0]` inline, in twenty-odd places. That
 * meant a roster entry written "Jonathan (Jack) Carney" was greeted everywhere
 * as "Jonathan" -- precisely the name the parenthetical was written to avoid.
 *
 * This module is the single derivation. Import `firstNameOf`; do not re-split a
 * name at the call site.
 */

/**
 * Name suffixes and post-nominal credentials, so neither a trailing "Jane Doe,
 * RN" nor a parenthetical "Jane Doe (RN)" is mistaken for a given name.
 * Lowercased, periods stripped. Shared with the Entra display-name parsing in
 * platform/auth/match-person.ts, which is why it lives here rather than there.
 */
export const NAME_SUFFIXES = new Set([
  "jr", "sr", "ii", "iii", "iv", "v",
  "md", "do", "rn", "np", "pa", "phd", "mph", "msn", "dnp", "dds", "dmd",
  "psyd", "edd", "lcsw", "esq", "mba", "ms", "ma", "bs", "ba",
]);

/**
 * The other thing people put in parentheses after their name. "Peggy (she/her)
 * Bia" must greet "Peggy", never "she/her". Most pronoun sets carry a slash and
 * are caught by the slash rule below; this list covers the bare single-word form
 * ("Peggy (she) Bia") that the slash rule misses.
 */
const PRONOUNS = new Set([
  "he", "him", "his", "she", "her", "hers", "they", "them", "their", "theirs",
  "ze", "zir", "hir", "xe", "xem", "ey", "em", "fae", "faer", "per", "pers",
]);

/**
 * The first parenthetical group that reads as a given name, or null.
 *
 * Scans every group rather than only the first, so "Bo (Jack) Peng (he/him)"
 * still finds "Jack": the pronoun group is skipped, not treated as terminal.
 */
function preferredFromParenthetical(name: string): string | null {
  for (const group of name.matchAll(/\(([^)]*)\)/g)) {
    const first = group[1].trim().split(/\s+/)[0] ?? "";
    if (first === "") continue;
    // A slash is a pronoun set ("she/her") or an either/or ("Bob/Robert").
    // Neither is a name we can greet with confidence, so fall through.
    if (first.includes("/")) continue;
    const bare = first.toLowerCase().replace(/\./g, "");
    if (PRONOUNS.has(bare) || NAME_SUFFIXES.has(bare)) continue;
    // Letters plus the punctuation real given names carry. A digit or symbol
    // means the parenthetical is an annotation, not a name.
    if (!/^\p{L}[\p{L}'’-]*$/u.test(first)) continue;
    return first;
  }
  return null;
}

/**
 * The name to greet someone by, honoring a parenthetical preferred name.
 *
 * "Jonathan (Jack) Carney", "(Jack) Jonathan Carney", and "Carney, Jonathan
 * (Jack)" all greet "Jack"; "Jonathan Carney" greets "Jonathan". A parenthetical
 * that is a pronoun set, a credential, or anything not shaped like a name is
 * ignored, and the leading token wins instead.
 *
 * Returns "" when there is no usable name, so each caller keeps its own
 * fallback: emails greet "there", the dashboard drops the name entirely.
 *
 * Known limit: an arbitrary word in parentheses ("Jane Doe (inactive)") reads as
 * a preferred name. The realistic contents of this column are preferred names,
 * pronouns, and credentials, and the latter two are handled; a free-text
 * annotation in a member's name is a data problem to fix in /admin/people.
 */
export function firstNameOf(name: string | null | undefined): string {
  const text = (name ?? "").trim();
  if (text === "") return "";
  return preferredFromParenthetical(text) ?? text.split(/\s+/)[0] ?? "";
}
