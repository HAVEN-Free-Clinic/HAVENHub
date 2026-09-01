/**
 * The INTP Spanish assessment history: the list of what INTP scored whom, and
 * when, going back to Spring 2012.
 *
 * Two stores, one writer. SpanishAssessmentRecord is the per-term history;
 * PersonLanguage.score is the current score that scheduling and the profile
 * badge read. Everything that changes a score goes through
 * recordLanguageAssessment (in ./index), which writes both, so the denormalized
 * copy cannot drift from the history.
 *
 * Everything here was inline in the review page's server actions, which meant
 * none of it could be tested and two buttons on the same page wrote the same
 * fact differently (one through recordLanguageAssessment with an audit row and a
 * member email, one straight to updateMany with neither).
 */

import { prisma } from "@/platform/db";
import { LanguageValidationError } from "./catalog";
import {
  ASSESSMENT_SEASONS,
  type AssessmentSeason,
  formatTermLabel,
  normalizeTermLabel,
  parseTermLabel,
  termRankOf,
} from "./assessment-terms";

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

/** A score outside 1-5 is not a score. Returns null for "no score recorded". */
export function normalizeScore(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
}

/** "plus" | "minus" | null. Anything else is not a modifier. */
export function normalizeModifier(raw: unknown): string | null {
  const s = raw === null || raw === undefined ? "" : String(raw);
  return s === "plus" || s === "minus" ? s : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The person's most recent assessment, for the profile badge.
 *
 * Ordered on termRank, never on the term label: see ./assessment-terms.
 */
export async function latestSpanishAssessment(personId: string) {
  return prisma.spanishAssessmentRecord.findFirst({
    where: { personId },
    orderBy: [{ termRank: "desc" }, { createdAt: "desc" }],
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
            { person: { name: { contains: search, mode: "insensitive" as const } } },
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
};

/**
 * The cross-check INTP asked for: people carrying a VERIFIED Spanish flag in Hub
 * whose assessment record does not support interpreting clinic-wide.
 *
 * Two ways to land here:
 *   - no-assessment          -> flagged in Hub, never on the assessment list
 *   - below-interpreter-bar  -> flagged in Hub, but most recently scored 1-3
 *
 * A 1-3 is not "wrong", it is conversational: some departments staff it and some
 * do not. This is a worklist for INTP to re-confirm, not an automatic revocation,
 * which is why nothing here writes.
 */
export const CLINIC_WIDE_INTERPRETER_MIN_SCORE = 4;

export async function listSpanishFlagMismatches(): Promise<FlagMismatch[]> {
  const flagged = await prisma.personLanguage.findMany({
    where: {
      language: "es",
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
    if (record === undefined && f.score === null) {
      out.push({
        personId: f.personId,
        name: f.person.name,
        netId: f.person.netId,
        score: null,
        term: null,
        reason: "no-assessment",
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
