/**
 * Matching a name written on the board attendance sheet to a Person.
 *
 * The sheet is a hand-kept roster: it writes everyday names ("Sam Suh", "Pete
 * Hatzelamprou", "Lucy W Kim") while Person.name holds whatever the roster
 * import wrote ("Samuel Suh", "Panagiotis (Pete) Hatzelamprou", "Lucy Kim").
 * Three mechanical variants close most of that gap, and the rest is an explicit
 * table of names ops confirmed.
 *
 * The rule this module exists to enforce: never resolve a name by similarity.
 * A surname matcher offered "Nathan Lai" -> "Kevin Lai" and "Justin Zhu" ->
 * "William Zhu" on this very sheet, and either would have attached one person's
 * attendance record, and therefore their unexcused-absence count, to another.
 * A name that does not match exactly on one of the variants below, or appear in
 * the table below, is treated as somebody the hub does not know yet.
 */

import { firstNameOf } from "@/platform/person-name";

/**
 * Sheet spellings that no mechanical variant can reach, mapped to the name the
 * hub holds. Keyed on the sheet's exact text (whitespace collapsed) so each
 * entry is unambiguous about which row it rewrites.
 *
 * Every entry below was corroborated against the candidate's department, not
 * guessed from the name alone: the sheet's department for the row matches a
 * DIRECTOR membership the candidate actually holds (Suh/Behavioral Health,
 * Feliciano/Community Relations, Talib/Education, Liu and Ma/Pharmacy,
 * Okeke/ICDD, Kim/LCC). The two Clinical Advisor entries are the exceptions and
 * are marked as such: Nguyen and Levine served on the 2024-25 board and their
 * only surviving memberships are later volunteer ones, so the corroboration
 * there is the first name plus surname plus era, and nothing stronger.
 *
 * The import prints every alias it applies in the dry-run report, so this table
 * is reviewable before anything is written rather than trusted on sight.
 */
export const NAME_ALIASES: Record<string, string> = {
  // Everyday form of a formal name.
  "Sam Suh": "Samuel Suh",
  "Matt Liu": "Matthew Liu",
  // Middle name the sheet omits.
  "Kyle Feliciano": "Kyle Brennan Feliciano",
  "Cindy Khanh Nguyen": "Cindy Nguyen", // Clinical Advisor, era-matched only.
  "Arielle Richey Levine": "Arielle Levine", // Clinical Advisor, era-matched only.
  // Misspellings in the sheet.
  "Anmara Talib": "Ammara Talib",
  "Yuxan Ma": "YuXuan (Christina) Ma",
  // Nickname with no relationship to the formal name.
  "Ozi Okeke": "Ifunanya Okeke",
  // Two spellings of one person, neither of whom the hub holds. Collapsing
  // them here keeps the import from creating the same director twice.
  "Mirriam Mananah": "Miriam Mananah",
};

/** Lowercased, accent-free, punctuation-free token list. */
function tokenize(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t !== "");
}

/** Everything outside parentheses, e.g. "Beatriz (Betty) Duran-Becerra" -> "Beatriz Duran-Becerra". */
function withoutParentheticals(name: string): string {
  return name.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Middle initials dropped, so "Lucy W Kim" and "Lucy Kim" are one key.
 *
 * Only interior single letters go: a leading or trailing one is a real (if
 * short) name part, and dropping it would collapse distinct people.
 */
function withoutMiddleInitials(tokens: string[]): string[] {
  if (tokens.length < 3) return tokens;
  return tokens.filter((t, i) => i === 0 || i === tokens.length - 1 || t.length > 1);
}

/**
 * Every key a name should be findable under.
 *
 * "Panagiotis (Pete) Hatzelamprou" yields both "panagiotis hatzelamprou" and
 * "pete hatzelamprou", which is how the sheet's everyday spellings land on the
 * roster's formal ones without any similarity test.
 */
export function nameKeys(name: string): string[] {
  const formal = tokenize(withoutParentheticals(name));
  if (formal.length === 0) return [];

  const variants: string[][] = [formal];

  // The parenthetical preferred name replaces the leading token: firstNameOf
  // already owns the rules for which parentheticals are names and which are
  // pronouns or credentials, so this never has to re-decide that.
  const preferred = tokenize(firstNameOf(name))[0];
  if (preferred && preferred !== formal[0]) variants.push([preferred, ...formal.slice(1)]);

  for (const variant of [...variants]) {
    const trimmed = withoutMiddleInitials(variant);
    if (trimmed.length !== variant.length) variants.push(trimmed);
  }

  return [...new Set(variants.map((v) => v.join(" ")))];
}

/** A key that more than one Person answers to, which the import refuses to use. */
export const AMBIGUOUS = Symbol("ambiguous");

export type PersonIndex = Map<string, string | typeof AMBIGUOUS>;

/**
 * Indexes people by every key their name yields.
 *
 * A key two people share is poisoned rather than resolved to either of them.
 * That is the whole safety property: the import would rather report "two people
 * are called this" than silently pick one and file a strike-bearing absence
 * against the wrong director.
 */
export function buildPersonIndex(people: Array<{ id: string; name: string }>): PersonIndex {
  const index: PersonIndex = new Map();
  for (const person of people) {
    for (const key of nameKeys(person.name)) {
      const existing = index.get(key);
      if (existing === undefined) index.set(key, person.id);
      else if (existing !== person.id) index.set(key, AMBIGUOUS);
    }
  }
  return index;
}

export type NameMatch = { canonicalName: string; viaAlias: boolean } & (
  | { kind: "matched"; personId: string }
  | { kind: "ambiguous" }
  | { kind: "unknown" }
);

/** Resolves one sheet name, applying the alias table first. */
export function matchName(sheetName: string, index: PersonIndex): NameMatch {
  const aliased = NAME_ALIASES[sheetName];
  const canonicalName = aliased ?? withoutParentheticals(sheetName);
  const viaAlias = aliased !== undefined;

  for (const key of nameKeys(canonicalName)) {
    const hit = index.get(key);
    if (hit === undefined) continue;
    if (hit === AMBIGUOUS) return { kind: "ambiguous", canonicalName, viaAlias };
    return { kind: "matched", personId: hit, canonicalName, viaAlias };
  }
  return { kind: "unknown", canonicalName, viaAlias };
}
