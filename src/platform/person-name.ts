/**
 * The one place a person's name is derived, split, or rendered.
 *
 * `Person` stores the name in parts: `legalFirstName`, `legalMiddleName`,
 * `lastName`, and an optional `preferredFirstName`. The `name` column survives
 * as a DERIVED display string, recomputed from those parts on every write, so
 * that the roughly sixty read sites, the `orderBy: { name: "asc" }` queries, and
 * the `contains` searches that predate the split keep working untouched.
 *
 * Before the split there was one free-text column, and the only way to record a
 * preferred name was to write it in parentheses: "Jonathan (Jack) Carney". That
 * convention still arrives from outside (the attendings contact sheet, the board
 * attendance workbook, Entra display names), so `firstNameOf` and
 * `preferredFromParenthetical` still read it. What changed is that HAVEN Hub no
 * longer stores it that way: `splitPersonName` lifts the parenthetical into a
 * real column once, at the boundary.
 *
 * Import from here; do not re-split a name at the call site.
 */

// Type-only, so this module stays a runtime leaf that anything can import.
import type { Prisma } from "@prisma/client";

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
 * Surname particles. A name containing one cannot be split by counting tokens,
 * because the surname runs from the particle to the end: "Maria de la Cruz" is
 * Maria / de la Cruz, not Maria / de la / Cruz.
 *
 * Every entry is at least two characters. The single-letter particles some
 * languages carry ("y", "i") are deliberately absent: they are indistinguishable
 * from a middle initial, and mistaking "Jane Y Doe" for a particle surname is a
 * worse error than missing a rare Spanish compound. A split that hits a particle
 * is flagged for review either way.
 */
const SURNAME_PARTICLES = new Set([
  "de", "del", "della", "di", "da", "do", "dos", "das", "du",
  "van", "von", "der", "den", "ter", "ten",
  "la", "las", "le", "les", "el", "al",
  "bin", "ibn", "ben", "af", "av", "st", "san", "santa",
]);

/** Lowercased with periods stripped, the form both suffix sets are keyed by. */
function bare(token: string): string {
  return token.toLowerCase().replace(/\./g, "");
}

function isSuffix(token: string): boolean {
  return token !== "" && NAME_SUFFIXES.has(bare(token));
}

/** A middle initial: one letter, optionally followed by a period. */
function isInitial(token: string): boolean {
  return /^\p{L}\.?$/u.test(token);
}

/**
 * Is this written the way a given name is written?
 *
 * One leading uppercase letter, then at least one lowercase. That accepts Jack,
 * Betty, Christina, Mary-Kate and O'Neill, and rejects the two shapes an
 * annotation actually takes: lowercase ("inactive") and ALL-CAPS ("LOA"). It is
 * a spelling test, not a dictionary, which is the whole reason it has a hole:
 * "Inactive" passes. Used only to decide whether a lifted parenthetical is
 * trusted or queued, never to reject a name outright.
 */
function looksLikeGivenName(token: string): boolean {
  return /^\p{Lu}[\p{L}'’-]*\p{Ll}[\p{L}'’-]*$/u.test(token);
}

/**
 * The first parenthetical group that reads as a given name, or null.
 *
 * Scans every group rather than only the first, so "Bo (Jack) Peng (he/him)"
 * still finds "Jack": the pronoun group is skipped, not treated as terminal.
 *
 * Still exported because two importers read contact sheets that use the
 * convention (platform/attendings/import/roster.ts and the board attendance
 * workbook), and because Entra display names arrive carrying it.
 */
export function preferredFromParenthetical(name: string): string | null {
  for (const group of name.matchAll(/\(([^)]*)\)/g)) {
    const first = group[1].trim().split(/\s+/)[0] ?? "";
    if (first === "") continue;
    // A slash is a pronoun set ("she/her") or an either/or ("Bob/Robert").
    // Neither is a name we can greet with confidence, so fall through.
    if (first.includes("/")) continue;
    if (PRONOUNS.has(bare(first)) || NAME_SUFFIXES.has(bare(first))) continue;
    // Letters plus the punctuation real given names carry. A digit or symbol
    // means the parenthetical is an annotation, not a name.
    if (!/^\p{L}[\p{L}'’-]*$/u.test(first)) continue;
    return first;
  }
  return null;
}

/**
 * The stored name parts, as every renderer here wants them. Structurally
 * satisfied by a `Person` row, so callers pass the person straight through.
 */
export type PersonNameParts = {
  legalFirstName: string;
  legalMiddleName?: string | null;
  lastName: string;
  preferredFirstName?: string | null;
};

/** What `splitPersonName` recovers from one free-text string. */
export type SplitName = {
  legalFirstName: string;
  legalMiddleName: string | null;
  lastName: string;
  preferredFirstName: string | null;
  /**
   * True when the split is a guess rather than a reading. Persisted to
   * `Person.nameNeedsReview` and surfaced in /admin/people, so an ambiguous name
   * is corrected by a human once instead of being re-guessed at every render.
   */
  needsReview: boolean;
};

/**
 * Recover name parts from a single free-text name.
 *
 * The backfill's splitter, and the parser for any importer that receives one
 * undifferentiated name string. It never refuses: an unsplittable name still
 * yields the best available parts, with `needsReview` set so the guess is
 * visible rather than silent. That matters because `lastName` is NOT NULL, and
 * a migration that threw on "Cher" would block on the first mononym.
 *
 * Confident where nothing was interpreted ("Jonathan Carney", "Jane Q Doe", and
 * a parenthetical drawn from the closed pronoun and credential lists like
 * "Peggy (she/her) Bia"), and where a lifted parenthetical is spelled like a
 * given name ("Jonathan (Jack) Carney").
 *
 * Flagged everywhere else, and the list is deliberately long, because this runs
 * once and is not reversible:
 *   - a lifted parenthetical that is NOT spelled like a given name, which is
 *     what an annotation looks like: "(inactive)", "(LOA)"
 *   - particle surnames ("Maria de la Cruz")
 *   - the "Last, First" comma form, and stripped credentials ("Jane Doe, RN")
 *   - mononyms ("Cher"), which leave lastName empty
 *   - a given name that is itself an initial ("J. R. Carney" is not "J.")
 *   - any three-or-more token name whose middle is not a bare initial:
 *     "Guadalupe Hernandez Zavala" is as likely two surnames as a middle name,
 *     and only the person knows which
 */
export function splitPersonName(raw: string | null | undefined): SplitName {
  const text = (raw ?? "").trim();
  const empty: SplitName = {
    legalFirstName: "",
    legalMiddleName: null,
    lastName: "",
    preferredFirstName: null,
    needsReview: true,
  };
  if (text === "") return empty;

  // A parenthetical we LIFT is trusted only when it is written like a name.
  //
  // The pronoun and credential lists are closed, so discarding a match from them
  // interprets nothing and stays confident. A lift does interpret, and the two
  // things that end up in these parentheses look different: a nickname is
  // capitalised ("(Jack)", "(Betty)", "(Christina)") and an annotation is not
  // ("(inactive)", "(LOA)", "(do not schedule)"). Capitalisation is the only
  // signal separating them, so it decides whether the lift ships or goes to the
  // review queue. Known limit: a capitalised annotation, "(Inactive)", reads as a
  // nickname and always will. It is pinned in the tests as a limit, not a bug.
  const preferredFirstName = preferredFromParenthetical(text);
  // A parenthetical carrying more than one token has had part of itself thrown
  // away: "Antonio Bolea (Tony Vega)" lifts "Tony" and drops "Vega", and nothing
  // here can tell a second given name from the surname he actually goes by.
  const multiWordParenthetical = /\([^)]*\p{L}[^)\s]*\s+\p{L}[^)]*\)/u.test(text);
  let needsReview =
    preferredFirstName !== null &&
    (!looksLikeGivenName(preferredFirstName) || multiWordParenthetical);

  // Every parenthetical is consumed here: the usable one became the preferred
  // name, and the rest were pronouns or credentials that are not part of a name.
  let rest = text.replace(/\([^)]*\)/g, " ").trim();

  // A comma is either a trailing credential ("Jane Doe, RN") or the inverted
  // form ("Carney, Jonathan"). What follows it decides which.
  //
  // In the inverted form the surname is settled: everything BEFORE the comma is
  // it, however many words that is, so it is taken whole and only the part after
  // the comma is tokenised. Folding the two halves back into one string and
  // re-splitting turned "Ponce Terashima, Javier" into Javier / Ponce /
  // Terashima, which files him under a surname he does not have.
  let invertedSurname: string | null = null;
  const commaAt = rest.indexOf(",");
  if (commaAt !== -1) {
    const before = rest.slice(0, commaAt).trim();
    const after = rest.slice(commaAt + 1).trim();
    if (isSuffix(after.split(/\s+/)[0] ?? "")) {
      rest = before;
    } else {
      rest = after;
      invertedSurname = before;
    }
    needsReview = true;
  }

  const tokens = rest.split(/\s+/).filter((token) => token !== "");
  // "John Smith Jr": a suffix with no comma to announce it.
  while (tokens.length > 2 && isSuffix(tokens[tokens.length - 1])) {
    tokens.pop();
    needsReview = true;
  }

  // "Jane Q Doe" displays as "Jane Doe" and nobody minds, because the given name
  // survives. "J. R. Carney" displays as "J. Carney", which is not what J. R. is
  // called: when the given name is ITSELF an initial, the person goes by the set.
  if (tokens.length > 0 && isInitial(tokens[0])) needsReview = true;

  // The inverted form already knows its surname, so the tokens left are the
  // given name and any middle names, and none of the token-counting rules below
  // apply to them.
  if (invertedSurname !== null) {
    return {
      legalFirstName: tokens[0] ?? "",
      legalMiddleName: tokens.slice(1).join(" ") || null,
      lastName: invertedSurname,
      preferredFirstName,
      needsReview: true,
    };
  }

  if (tokens.length === 0) return { ...empty, preferredFirstName };
  if (tokens.length === 1) {
    return {
      legalFirstName: tokens[0],
      legalMiddleName: null,
      lastName: "",
      preferredFirstName,
      needsReview: true,
    };
  }
  if (tokens.length === 2) {
    return {
      legalFirstName: tokens[0],
      legalMiddleName: null,
      lastName: tokens[1],
      preferredFirstName,
      needsReview,
    };
  }

  // Three or more. A particle anywhere between the given name and the final
  // token means the surname starts there and runs to the end.
  const particleAt = tokens.findIndex(
    (token, i) =>
      i >= 1 && i <= tokens.length - 2 && SURNAME_PARTICLES.has(token.toLowerCase()),
  );
  if (particleAt !== -1) {
    return {
      legalFirstName: tokens[0],
      legalMiddleName: tokens.slice(1, particleAt).join(" ") || null,
      lastName: tokens.slice(particleAt).join(" "),
      preferredFirstName,
      needsReview: true,
    };
  }

  return {
    legalFirstName: tokens[0],
    legalMiddleName: tokens.slice(1, -1).join(" "),
    lastName: tokens[tokens.length - 1],
    preferredFirstName,
    // A single bare initial is a middle initial and nothing else. Anything
    // longer is a middle name or a second surname, and we cannot tell which.
    needsReview: needsReview || !(tokens.length === 3 && isInitial(tokens[1])),
  };
}

/**
 * The name to greet someone by: their preferred first name, else their legal
 * one.
 *
 * Accepts a `Person` (the normal case, reading the stored columns) or a bare
 * string (an Applicant name, an Entra display name, an imported contact sheet
 * cell), where it falls back to the parenthetical convention that predates the
 * split.
 *
 * Returns "" when there is no usable name, so each caller keeps its own
 * fallback: emails greet "there", the dashboard drops the name entirely.
 */
export function firstNameOf(person: PersonNameParts): string;
export function firstNameOf(name: string | null | undefined): string;
export function firstNameOf(input: PersonNameParts | string | null | undefined): string {
  if (typeof input === "object" && input !== null) {
    return (input.preferredFirstName ?? "").trim() || input.legalFirstName.trim();
  }
  const text = (input ?? "").trim();
  if (text === "") return "";
  return preferredFromParenthetical(text) ?? text.split(/\s+/)[0] ?? "";
}

/**
 * The greeting name for an Applicant or an OnboardingContract.
 *
 * Those two name their columns `firstName` / `lastName` rather than
 * `legalFirstName` / `lastName`, because they predate the Person split and
 * describe someone who may have no Person row at all. Same rule, different
 * shape: what they go by, else their first name.
 */
export function applicantFirstName(applicant: {
  firstName: string;
  preferredFirstName?: string | null;
}): string {
  return (applicant.preferredFirstName ?? "").trim() || applicant.firstName.trim();
}

/**
 * How a person is shown everywhere that is not an identity document: "Jack
 * Carney". This is the value written to the derived `Person.name` column, so
 * every surface reading that column shows it without changing.
 *
 * The middle name is deliberately absent. It belongs to `legalNameOf`.
 */
export function displayNameOf(person: PersonNameParts): string {
  return [firstNameOf(person), person.lastName].filter(Boolean).join(" ").trim();
}

/**
 * The name of record: "Jonathan Peter Carney". For the Epic access request sent
 * to YNHH IT, the signed onboarding contract, and the admin person record. Never
 * for a roster, an email greeting, or a badge.
 */
export function legalNameOf(person: PersonNameParts): string {
  return [person.legalFirstName, person.legalMiddleName, person.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * The name columns a person search has to cover.
 *
 * `name` holds only the DISPLAY name, so a person stored as "Jack Carney" is not
 * matched by "Jonathan" and a person with a middle name is not matched by it.
 * Spread this into a Prisma `OR` instead of writing `{ name: { contains } }`,
 * which silently stops finding people the moment they set a preferred name.
 *
 *   where.OR = [...personNameSearchClauses(term), { netId: {...} }]
 *
 * `path` prefixes the columns for a search across a relation, e.g.
 * `personNameSearchClauses(term, "person")` yields `{ person: { name: ... } }`.
 */
export function personNameSearchClauses(
  term: string,
  path?: string,
): Array<Record<string, unknown>> {
  const match = { contains: term, mode: "insensitive" as const };
  const clauses: Array<Record<string, unknown>> = [
    { name: match },
    { legalFirstName: match },
    { lastName: match },
    // The middle name is included even though no surface DISPLAYS it: it is the
    // one part of a person's name that is otherwise unsearchable, and somebody
    // known at clinic by a second surname is exactly who gets typed into a
    // search.
    //
    // It is also the only NULLABLE column here, and that is why it carries an
    // explicit IS NOT NULL guard rather than a bare `contains`. In Postgres
    // `"legalMiddleName" LIKE '%x%'` is NULL for a row with no middle name; NULL
    // survives the surrounding OR, and NOT(NULL) is NULL, so under any negation
    // (the audience builder's "does not contain", a NONE group) every person
    // without a middle name silently vanished from the result. Same shape as
    // #224. The guard turns that NULL into a false, which negates correctly.
    { AND: [{ legalMiddleName: { not: null } }, { legalMiddleName: match }] },
  ];
  return path ? clauses.map((clause) => ({ [path]: clause })) : clauses;
}

/**
 * The order every list of people is shown in.
 *
 * Surname, then the LEGAL given name, then id. Spread it into a Prisma
 * `orderBy` instead of writing `{ name: "asc" }`, which orders by the display
 * name and therefore has two problems: it sorts people under their given name
 * while the recruitment half of this app already sorts them under their
 * surname (see historical-applicants.ts and applicant-sort.ts), and it makes a
 * roster JUMP the moment somebody sets a preferred name, reordering a list
 * under a reader who did nothing.
 *
 * The id tiebreaker is load-bearing on any paginated query: two people tied on
 * both name columns otherwise order arbitrarily, and Postgres may choose
 * differently across page boundaries, dropping one row and repeating another.
 *
 * Known wart, and a smaller cousin of #534: a mononym has `lastName = ""`, and
 * an ascending sort puts empty first, so Cher heads the list. Unlike the
 * historical-applicant case, which had 151 nameless rows and needed two
 * queries, Person cannot hold a nameless row at all (person-name-write.ts
 * refuses one), so this is only ever the handful of people who genuinely have
 * one name, and they are flagged for review anyway.
 */
export const PERSON_NAME_ORDER: Prisma.PersonOrderByWithRelationInput[] = [
  { lastName: "asc" },
  { legalFirstName: "asc" },
  { id: "asc" },
];

/**
 * The in-memory half of PERSON_NAME_ORDER, for a list the database did not
 * order: rows built from an aggregation, a Map, or several queries stitched
 * together.
 *
 *   rows.sort(comparePersonName)
 *
 * Keyed on the LEGAL name for the same reason the Prisma constant is. Sorting
 * on the display name means the list jumps the moment somebody sets a preferred
 * name, reordering itself under a reader who did nothing.
 *
 * The row has to carry `legalFirstName` and `lastName`, which usually means
 * widening a `select`. That is the cost of ordering people the same way
 * everywhere; sorting the rendered string instead is what leaves half the app
 * filed under given names and the other half under surnames.
 */
export function comparePersonName(a: PersonNameParts, b: PersonNameParts): number {
  const [aLast, aFirst] = sortKeyOf(a);
  const [bLast, bFirst] = sortKeyOf(b);
  return aLast.localeCompare(bLast) || aFirst.localeCompare(bFirst);
}

/**
 * The same order, for a query that reaches Person through a relation.
 *
 * `PERSON_NAME_ORDER` is typed as a Person orderBy and cannot nest, so a query
 * on TeamsMessage, PersonLanguage, EpicRequest and friends needs this instead of
 * `{ person: { name: "asc" } }`. Same three keys, same reasons.
 *
 *   orderBy: personNameOrderVia("person")
 */
export function personNameOrderVia(relation: string): Array<Record<string, unknown>> {
  return PERSON_NAME_ORDER.map((clause) => ({ [relation]: clause }));
}

/** Accent-folded and lowercased, so "Peña" collates beside "Pena". */
function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Surname first, then legal first name, for the surfaces that sort people.
 * Legal rather than preferred: a roster sorted by preferred name reshuffles
 * whenever somebody sets one, and the surname is what a reader scans for.
 */
export function sortKeyOf(person: PersonNameParts): [string, string] {
  return [fold(person.lastName), fold(person.legalFirstName)];
}
