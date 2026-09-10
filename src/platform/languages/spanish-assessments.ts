/**
 * The INTP Spanish assessment history: the list of what INTP scored whom, and
 * when, going back to Spring 2012.
 *
 * Two stores: SpanishAssessmentRecord is the per-term history; PersonLanguage.score
 * is a denormalized copy of it, the current score that scheduling and the
 * profile badge read. The invariant that matters is that a write meaning to
 * change what's CURRENT keeps the two in step; a write meaning only to correct
 * or extend the archival record does not touch PersonLanguage at all. This file
 * is not a closed list of every writer to either store -- read each function's
 * own doc comment for what it does and does not touch -- but two write paths
 * are worth naming because they are the ones that keep the two stores in step:
 *
 *   - recordLanguageAssessment (in ./index), the member-queue write path,
 *     writes BOTH stores itself: PersonLanguage directly, then this module's
 *     upsertSpanishAssessmentForTerm to mirror the same call into history.
 *   - carryForwardApplicationAssessments (in ./applicant-review), the
 *     promotion-time write path for a pre-acceptance verdict, writes only
 *     PersonLanguage and returns which entries it actually wrote (`written`).
 *     Its caller (promotion.ts) mirrors ONLY the written entries into history
 *     afterward, outside the promotion transaction. Nothing here enforces that
 *     contract; a caller that mirrors an unfiltered or unwritten entry can
 *     still drift PersonLanguage from the history it's supposed to mirror.
 *
 * updateSpanishAssessment and addPersonToSpanishHistory, both below, are the
 * opposite case: each edits or creates a history row only, by design, and
 * neither one touches PersonLanguage.
 *
 * Everything here was inline in the review page's server actions, which meant
 * none of it could be tested and two buttons on the same page wrote the same
 * fact differently (one through recordLanguageAssessment with an audit row and a
 * member email, one straight to updateMany with neither).
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import {
  CLINIC_WIDE_INTERPRETER_MIN_SCORE,
  LanguageValidationError,
  SPANISH,
  interpreterBarFor,
  isSpanishScore,
  meetsInterpreterBar,
} from "./catalog";
import {
  ASSESSMENT_SEASONS,
  type AssessmentSeason,
  formatTermLabel,
  normalizeTermLabel,
  parseTermLabel,
  termRankOf,
} from "./assessment-terms";
import { personNameSearchClauses } from "@/platform/person-name";

export type SpanishAssessmentRow = {
  id: string;
  personId: string | null;
  /** The Person's Hub name when linked, else the name the assessment list carried. */
  displayName: string | null;
  email: string;
  term: string;
  score: number | null;
  modifier: string | null;
  notes: string | null;
  verified: boolean | null;
};

/**
 * A value off the scale is not a score. Returns null for "no score recorded".
 *
 * Parsed with Number, not parseInt: parseInt("3.5") is 3, which passed the old
 * integer check and stored a silently downgraded assessment. Number also refuses
 * trailing garbage, so "3.5abc" is null rather than 3.5.
 */
export function normalizeScore(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return isSpanishScore(n) ? n : null;
}

/** "plus" | "minus" | null. Anything else is not a modifier. */
export function normalizeModifier(raw: unknown): string | null {
  const s = raw === null || raw === undefined ? "" : String(raw);
  return s === "plus" || s === "minus" ? s : null;
}

/**
 * Read a score and a modifier off the same form, and refuse to store both.
 *
 * "3.5+" is not a point on the scale. The modifier is how the assessors wrote a
 * half step before the scale had one, so the two are the same idea in two
 * spellings and a row must carry at most one of them. The half step wins,
 * because it is what the reviewer just picked from a labelled list; the modifier
 * on a history row is inherited from the import and was never re-confirmed.
 *
 * Whole scores keep their modifier, so editing the notes on a legacy "4-" row
 * leaves the "4-" alone.
 */
export function normalizeScoreAndModifier(
  rawScore: unknown,
  rawModifier: unknown,
): { score: number | null; modifier: string | null } {
  const score = normalizeScore(rawScore);
  const modifier = normalizeModifier(rawModifier);
  if (score !== null && !Number.isInteger(score)) return { score, modifier: null };
  return { score, modifier };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The ordering that decides which of a person's records is their CURRENT one.
 *
 * Shared rather than repeated, because two callers now depend on agreeing about
 * it: the profile badge below reads the newest record, and
 * verifyAssessmentRecord decides whether a verdict may move the person's live
 * flag by asking whether the record being verified IS that one. If those two
 * orderings ever drifted apart, a verdict could update a live flag the profile
 * then contradicts.
 *
 * termRank, never the term label: see ./assessment-terms.
 */
const NEWEST_FIRST: Prisma.SpanishAssessmentRecordOrderByWithRelationInput[] = [
  { termRank: "desc" },
  { createdAt: "desc" },
];

/**
 * The person's most recent assessment, for the profile badge.
 */
export async function latestSpanishAssessment(personId: string) {
  return prisma.spanishAssessmentRecord.findFirst({
    where: { personId },
    orderBy: NEWEST_FIRST,
    select: { score: true, modifier: true, term: true, verified: true },
  });
}

/** Every term that has at least one record, newest first. Drives the filter dropdown. */
export async function listAssessmentTerms(): Promise<string[]> {
  const rows = await prisma.spanishAssessmentRecord.findMany({
    select: { term: true, termRank: true },
    distinct: ["term"],
    orderBy: [{ termRank: "desc" }, { term: "desc" }],
  });
  return rows.map((r) => r.term);
}

export type AssessmentHistoryPage = {
  rows: SpanishAssessmentRow[];
  total: number;
  page: number;
  pageCount: number;
};

export const HISTORY_PAGE_SIZE = 50;

/**
 * One page of assessment history, filtered by term and free-text search.
 *
 * Paginated because "All terms" spans 2012 to now and every row renders three
 * forms; the unpaginated version shipped the entire table into one RSC payload.
 */
export async function listSpanishAssessmentHistory(opts: {
  term?: string;
  search?: string;
  page?: number;
}): Promise<AssessmentHistoryPage> {
  const page = Math.max(1, opts.page ?? 1);
  const search = opts.search?.trim() ?? "";
  const where = {
    ...(opts.term ? { term: opts.term } : {}),
    ...(search
      ? {
          OR: [
            { email: { contains: search, mode: "insensitive" as const } },
            { name: { contains: search, mode: "insensitive" as const } },
            { notes: { contains: search, mode: "insensitive" as const } },
            ...personNameSearchClauses(search, "person"),
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.spanishAssessmentRecord.count({ where }),
    prisma.spanishAssessmentRecord.findMany({
      where,
      orderBy: [{ termRank: "desc" }, { name: "asc" }, { email: "asc" }],
      include: { person: { select: { name: true } } },
      skip: (page - 1) * HISTORY_PAGE_SIZE,
      take: HISTORY_PAGE_SIZE,
    }),
  ]);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      personId: r.personId,
      displayName: r.person?.name ?? r.name,
      email: r.email,
      term: r.term,
      score: r.score,
      modifier: r.modifier,
      notes: r.notes,
      verified: r.verified,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE)),
  };
}

export type FlagMismatch = {
  personId: string;
  name: string;
  netId: string | null;
  score: number | null;
  term: string | null;
  reason: "no-assessment" | "below-interpreter-bar";
  /**
   * Codes of the person's current departments that would still staff them at
   * this score. Empty when none would, which is the case that actually argues
   * for pulling the flag.
   */
  acceptedByDepartments: string[];
};

/**
 * The cross-check INTP asked for: people carrying a VERIFIED Spanish flag in Hub
 * whose assessment record does not support interpreting clinic-wide.
 *
 * Two ways to land here:
 *   - no-assessment          -> flagged in Hub, never on the assessment list
 *   - below-interpreter-bar  -> flagged in Hub, but most recently scored below 4
 *
 * A 1-3 is not "wrong", it is conversational: some departments staff it and some
 * do not, which is why each row carries the departments that still would. This
 * is a worklist for INTP to re-confirm, not an automatic revocation, and nothing
 * here writes.
 */
export async function listSpanishFlagMismatches(): Promise<FlagMismatch[]> {
  const activeTerm = await getActiveTerm();
  const flagged = await prisma.personLanguage.findMany({
    where: {
      language: SPANISH,
      verified: true,
      verifiedAt: { not: null },
      person: { status: "ACTIVE" },
    },
    select: {
      personId: true,
      score: true,
      person: { select: { name: true, netId: true } },
    },
    orderBy: { person: { name: "asc" } },
  });
  if (flagged.length === 0) return [];

  // Which of each person's current departments would still take them, so the row
  // says "PATS would still staff this person" rather than only "below the bar".
  const memberships = activeTerm
    ? await prisma.termMembership.findMany({
        where: {
          personId: { in: flagged.map((f) => f.personId) },
          termId: activeTerm.id,
          status: "ACTIVE",
        },
        select: {
          personId: true,
          department: { select: { code: true, minInterpreterScore: true } },
        },
      })
    : [];
  const deptsByPerson = new Map<string, Array<{ code: string; minInterpreterScore: number | null }>>();
  for (const m of memberships) {
    deptsByPerson.set(m.personId, [...(deptsByPerson.get(m.personId) ?? []), m.department]);
  }

  const records = await prisma.spanishAssessmentRecord.findMany({
    where: { personId: { in: flagged.map((f) => f.personId) } },
    orderBy: [{ termRank: "desc" }, { createdAt: "desc" }],
    select: { personId: true, score: true, term: true },
  });

  // First row per person wins: the query is already newest-first.
  const latest = new Map<string, { score: number | null; term: string }>();
  for (const r of records) {
    if (!r.personId || latest.has(r.personId)) continue;
    latest.set(r.personId, { score: r.score, term: r.term });
  }

  const out: FlagMismatch[] = [];
  for (const f of flagged) {
    const record = latest.get(f.personId);
    // The claim's own score counts as an assessment even with no history row,
    // so a score recorded in Hub before the import does not read as missing.
    const score = record?.score ?? f.score ?? null;
    const acceptedBy = (scoreForBar: number | null) =>
      (deptsByPerson.get(f.personId) ?? [])
        .filter((d) => meetsInterpreterBar(scoreForBar, interpreterBarFor(d)))
        .map((d) => d.code)
        .sort();

    if (record === undefined && f.score === null) {
      out.push({
        personId: f.personId,
        name: f.person.name,
        netId: f.person.netId,
        score: null,
        term: null,
        reason: "no-assessment",
        // Nobody is "accepted" on a missing assessment: the question this row
        // asks is whether the flag is real at all, which no bar can answer.
        acceptedByDepartments: [],
      });
      continue;
    }
    if (score !== null && score < CLINIC_WIDE_INTERPRETER_MIN_SCORE) {
      out.push({
        personId: f.personId,
        name: f.person.name,
        netId: f.person.netId,
        score,
        term: record?.term ?? null,
        reason: "below-interpreter-bar",
        acceptedByDepartments: acceptedBy(score),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Write the history row for an assessment. Called by recordLanguageAssessment,
 * which owns the PersonLanguage side; do not call it directly from a page.
 *
 * Upserts on (personId, term) so two reviewers scoring the same person in the
 * same term update one row instead of racing into two.
 */
export async function upsertSpanishAssessmentForTerm(input: {
  personId: string;
  term: string;
  score: number | null;
  verified: boolean;
}): Promise<void> {
  const term = normalizeTermLabel(input.term);
  await prisma.spanishAssessmentRecord.upsert({
    where: { personId_term: { personId: input.personId, term } },
    create: {
      email: "",
      personId: input.personId,
      term,
      termRank: termRankOf(term),
      score: input.score,
      verified: input.verified,
    },
    update: { score: input.score, verified: input.verified },
  });
}

/** What verifying one history row settled, for the caller to act on. */
export type AssessmentRecordVerdict = {
  /** Null when the row was never linked to a Hub account. */
  personId: string | null;
  term: string;
  /** The record's OWN score, which is the score this verdict is about. */
  score: number | null;
  /**
   * Whether this record is the person's current one (see NEWEST_FIRST). Only a
   * verdict on the newest record may move their live PersonLanguage flag; the
   * caller owns that write, and this is the fact it decides on.
   */
  isNewestForPerson: boolean;
};

/**
 * Record a reviewer's verdict on ONE history row, by id.
 *
 * WHAT THIS REPLACES, because the old shape is the bug. The Verify buttons on
 * the history tab used to post only a personId and call recordLanguageAssessment,
 * which meant the control was rendered against one fact and wrote a different
 * one. Three things followed, all of them live in production:
 *
 *   1. The row you clicked never changed. Its own `verified` column was never
 *      touched, so the badge stayed blank and the button stayed offered, and
 *      clicking again just did the whole thing a second time.
 *   2. It FABRICATED an assessment. recordLanguageAssessment mirrors into the
 *      ACTIVE term, so verifying a Fall 2024 record created a Summer 2026 one.
 *      Because latestSpanishAssessment orders on termRank, that invented row
 *      then OUTRANKED the real assessment on the member's profile, and it
 *      carried no score, so a genuine 5 read as no score at all.
 *   3. "Not verified" on an old row stripped a CURRENT member's live flag.
 *      verifiedLanguagesByPerson gates scheduling, capacity, badges and the
 *      passport on it, so a verdict about 2019 pulled someone out of the
 *      interpreter pool today.
 *
 * So this writes the record it was given and nothing else. It reports
 * `isNewestForPerson` rather than deciding for itself what that means for the
 * person, keeping this module's stated split intact: history rows here, the live
 * PersonLanguage flag in ./index.
 */
export async function verifyAssessmentRecord(input: {
  id: string;
  verified: boolean;
}): Promise<AssessmentRecordVerdict> {
  const record = await prisma.spanishAssessmentRecord.findUnique({
    where: { id: input.id },
    select: { id: true, personId: true, term: true, score: true },
  });
  if (!record) {
    throw new LanguageValidationError("That assessment record no longer exists.");
  }

  await prisma.spanishAssessmentRecord.update({
    where: { id: record.id },
    data: { verified: input.verified },
  });

  // An unlinked row has no person to be newest FOR. Answering false rather than
  // leaving it undefined keeps the caller from having to special-case it: there
  // is no live flag to move either way.
  if (!record.personId) {
    return { personId: null, term: record.term, score: record.score, isNewestForPerson: false };
  }

  const newest = await prisma.spanishAssessmentRecord.findFirst({
    where: { personId: record.personId },
    orderBy: NEWEST_FIRST,
    select: { id: true },
  });

  return {
    personId: record.personId,
    term: record.term,
    score: record.score,
    isNewestForPerson: newest?.id === record.id,
  };
}

/** Edit an imported or hand-entered history row in place. Does not touch PersonLanguage. */
export async function updateSpanishAssessment(input: {
  id: string;
  score: number | null;
  modifier: string | null;
  notes: string | null;
}): Promise<void> {
  await prisma.spanishAssessmentRecord.update({
    where: { id: input.id },
    data: {
      score: input.score,
      modifier: input.modifier,
      notes: input.notes?.trim() || null,
    },
  });
}

/**
 * Add a person to the history for a term, looking them up by NetID or email.
 *
 * Throws rather than silently returning: the caller renders the message, because
 * the previous bare `return` left the reviewer staring at a reset form with no
 * idea whether anything had happened.
 */
export async function addPersonToSpanishHistory(input: {
  netIdOrEmail: string;
  term: string;
  score: number | null;
  modifier: string | null;
}): Promise<void> {
  const needle = input.netIdOrEmail.trim().toLowerCase();
  if (!needle) throw new LanguageValidationError("Enter a NetID or email.");
  const term = normalizeTermLabel(input.term);
  if (!parseTermLabel(term)) {
    throw new LanguageValidationError(`"${input.term}" is not a term like "Spring 2026".`);
  }

  const person = await findPersonByNetIdOrEmail(needle);
  if (!person) {
    throw new LanguageValidationError(`No Hub account matches "${input.netIdOrEmail}".`);
  }

  const existing = await prisma.spanishAssessmentRecord.findUnique({
    where: { personId_term: { personId: person.id, term } },
    select: { id: true },
  });
  if (existing) {
    throw new LanguageValidationError(`${person.name} already has a ${term} assessment.`);
  }

  await prisma.spanishAssessmentRecord.create({
    data: {
      email: person.contactEmail ?? "",
      name: person.name,
      personId: person.id,
      term,
      termRank: termRankOf(term),
      score: input.score,
      modifier: input.modifier,
      verified: null,
    },
  });
}

/** Attach an unlinked imported row to a Hub account. Throws with a reason on failure. */
export async function linkSpanishAssessmentToPerson(input: {
  id: string;
  netIdOrEmail: string;
}): Promise<void> {
  const needle = input.netIdOrEmail.trim().toLowerCase();
  if (!needle) throw new LanguageValidationError("Enter a NetID or email.");

  const record = await prisma.spanishAssessmentRecord.findUnique({
    where: { id: input.id },
    select: { term: true },
  });
  if (!record) throw new LanguageValidationError("That assessment record no longer exists.");

  const person = await findPersonByNetIdOrEmail(needle);
  if (!person) {
    throw new LanguageValidationError(`No Hub account matches "${input.netIdOrEmail}".`);
  }

  const clash = await prisma.spanishAssessmentRecord.findUnique({
    where: { personId_term: { personId: person.id, term: record.term } },
    select: { id: true },
  });
  if (clash && clash.id !== input.id) {
    throw new LanguageValidationError(
      `${person.name} already has a ${record.term} assessment linked.`,
    );
  }

  await prisma.spanishAssessmentRecord.update({
    where: { id: input.id },
    data: { personId: person.id, name: person.name },
  });
}

async function findPersonByNetIdOrEmail(needle: string) {
  return prisma.person.findFirst({
    where: {
      OR: [
        { netId: { equals: needle, mode: "insensitive" } },
        { contactEmail: { equals: needle, mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, contactEmail: true },
  });
}

export {
  ASSESSMENT_SEASONS,
  formatTermLabel,
  parseTermLabel,
  termRankOf,
  normalizeTermLabel,
};
export type { AssessmentSeason };
