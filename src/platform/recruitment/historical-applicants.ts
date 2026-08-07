/**
 * Shared read layer for imported recruitment history (HistoricalApplicant).
 *
 * It lives in platform because two surfaces need the same search and the same
 * label: the history browser page (src/app/(app)/recruitment/history) and the
 * command palette's entity search (src/modules/search/entities.ts). A module
 * may not import another module, so platform is the side both can reach.
 *
 * Almost everything here exists because of one property of the imported data:
 * 151 identities arrived through an old interest form whose export carried no
 * name column at all, and firstName/lastName are NOT NULL columns, so those
 * rows hold EMPTY STRINGS rather than nulls. That single fact has already
 * produced two shipped bugs (#528 unreadable rows, #534 a result list that was
 * nothing but nameless rows). Both fixes live here now, once, instead of being
 * re-derived by every caller that reads this table.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";

/**
 * The columns every reader of this table needs to render a row: enough to
 * label it, identify it, and link to it. Deliberately narrow -- neither caller
 * shows application outcomes in a list, and the detail page loads its own.
 */
const SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  primaryEmail: true,
  netId: true,
} as const;

export type HistoricalApplicantRow = {
  id: string;
  firstName: string;
  lastName: string;
  primaryEmail: string;
  netId: string | null;
};

/** One word of a search term, matched against every identifier on the row. */
function matchesToken(token: string): Prisma.HistoricalApplicantWhereInput {
  return {
    OR: [
      { firstName: { contains: token, mode: "insensitive" } },
      { lastName: { contains: token, mode: "insensitive" } },
      { primaryEmail: { contains: token, mode: "insensitive" } },
      { netId: { contains: token, mode: "insensitive" } },
      { emails: { some: { email: { contains: token, mode: "insensitive" } } } },
    ],
  };
}

/**
 * Match a search term case-insensitively across every identifier a reviewer
 * might type in: first or last name, the display email, any OTHER email on
 * file for this identity, or NetID. An empty term matches everything.
 *
 * The emails relation matters as much as primaryEmail: an identity merged from
 * several sources keeps every address it was seen under, and the one a
 * reviewer remembers is often not the one promoted to primary.
 *
 * The term is split on whitespace and EVERY word must match something, because
 * a name is stored in two columns and no single one of them contains "Ada
 * Lovelace". Matching the whole term against each column in turn -- the
 * obvious reading, and what this did at first -- means typing a full name
 * finds nothing at all, which is the one thing someone is most likely to type.
 * Person.name has no such problem (one column, whole name), so the palette's
 * People group has always handled this and this one has to earn it.
 *
 * Splitting can only widen the result set, never narrow it: a column
 * containing "ada lovelace" contains "ada" and contains "lovelace" too. It
 * also makes the words independent, so a reviewer who types a surname first,
 * or a first name and a NetID together, still lands on the row.
 */
export function historicalApplicantWhere(term: string | undefined | null): Prisma.HistoricalApplicantWhereInput {
  const tokens = term?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (tokens.length === 0) return {};
  if (tokens.length === 1) return matchesToken(tokens[0]);
  return { AND: tokens.map(matchesToken) };
}

/** A nameless identity: both name columns are NOT NULL, so it is two empty strings. */
const NAMELESS: Prisma.HistoricalApplicantWhereInput = { firstName: "", lastName: "" };

/**
 * Fetch up to `take` matches, named identities FIRST and nameless ones only
 * filling whatever room is left.
 *
 * The split has to happen in the database, not after the fetch. An ascending
 * sort on an empty lastName puts all 151 nameless rows ahead of every real
 * name, so a single orderBy plus a take returned nameless rows and nothing
 * else, and re-sorting that page in memory could only reorder rows that were
 * already all nameless (#534). Prisma cannot express "empty string sorts last"
 * in one orderBy (nulls: "last" needs a nullable column, and these are not),
 * so this is two queries sharing one `where`. Both halves stay fully
 * searchable: a nameless identity is still reachable by its email or NetID.
 *
 * The second query is skipped entirely when the first already filled `take`,
 * which is the common case for a specific search.
 */
export async function findHistoricalApplicants(
  where: Prisma.HistoricalApplicantWhereInput,
  take: number,
): Promise<HistoricalApplicantRow[]> {
  const named = await prisma.historicalApplicant.findMany({
    where: { AND: [where, { NOT: NAMELESS }] },
    select: SELECT,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take,
  });

  const remaining = take - named.length;
  if (remaining <= 0) return named;

  const unnamed = await prisma.historicalApplicant.findMany({
    where: { AND: [where, NAMELESS] },
    select: SELECT,
    orderBy: [{ primaryEmail: "asc" }],
    take: remaining,
  });

  return [...named, ...unnamed];
}

/**
 * The imported data contains values in the email column that are not
 * addresses: a surname the source form put in the wrong field ("zentner"), a
 * full name ("sourav roy"), a typo ("paola.corral&yale.edu"), and outright junk
 * ("n/a", a street address). 20 of them. Callers use this to avoid printing
 * those under an Email heading, which would state something false.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

/**
 * What to call an identity in a list. A blank name is expected data, not a
 * defect, so falling back to the email keeps every row identifiable and
 * clickable; falling back again to the raw value covers the handful whose
 * email field holds a misplaced name (#528).
 */
export function historicalApplicantLabel(a: {
  firstName: string;
  lastName: string;
  primaryEmail: string;
}): string {
  const name = `${a.firstName} ${a.lastName}`.trim();
  return name || a.primaryEmail;
}
