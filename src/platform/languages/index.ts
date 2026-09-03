/**
 * Language capability: claims, human assessment, and the review queue.
 *
 * Generalizes what used to be four Spanish-only columns on Person. The semantics
 * are deliberately unchanged, so the interpreting department's workflow reads
 * the same as before:
 *
 *   - A row exists          -> the person claims or has been assessed on it.
 *   - verifiedAt IS NULL    -> awaiting human assessment. In the queue.
 *   - verifiedAt IS NOT NULL-> assessed. Out of the queue, whether the answer
 *                              was yes or no.
 *   - verified              -> the OUTCOME. Meaningless without verifiedAt;
 *                              never read it alone.
 *
 * Only a VERIFIED language gates anything (scheduling, capacity, the service
 * record). A self-reported claim is an intake signal and nothing more, which is
 * the distinction the original Spanish design got right and this preserves.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { languageClaimedContext } from "@/platform/email/templates/volunteers";
import { getSetting } from "@/platform/settings/service";
import { firstNameOf } from "@/platform/person-name";
import { log, errorAttrs } from "@/platform/logging";
import { getActiveTerm } from "@/platform/terms/active-term";
import { peopleWithPermission } from "@/platform/rbac/permission-holders";
import { LanguageValidationError, SPANISH, isLanguageCode, languageLabel } from "./catalog";
import { upsertSpanishAssessmentForTerm } from "./spanish-assessments";

/**
 * The catalog and its pure helpers are re-exported so every existing server
 * caller can keep importing them from "@/platform/languages". They LIVE in
 * ./catalog because this file imports prisma and notify, and a client component
 * that reached them through here would pull the server graph into the browser
 * bundle and break `next build`. Client components must import ./catalog
 * directly.
 */
export * from "./catalog";

/**
 * Claims awaiting assessment, clinic-wide.
 *
 * ACTIVE people only: an offboarded volunteer is not part of the interpreting
 * department's worklist even if they once claimed a language.
 */
export function languageReviewWhere(): Prisma.PersonLanguageWhereInput {
  return { verifiedAt: null, person: { status: "ACTIVE" } };
}

export type LanguageReviewRow = {
  id: string;
  personId: string;
  name: string;
  netId: string | null;
  language: string;
  languageLabel: string;
  score: number | null;
};

/**
 * One queue for everyone. This used to split on active-term INTP membership
 * into a scored assessment queue and an unscored "general verification" one,
 * which meant a Spanish speaker outside interpreting never got a number at all.
 * Departments differ on what they will staff (Department.minInterpreterScore),
 * and that call needs a score for every speaker, not only for interpreters.
 */
export async function listLanguageReviewQueue(): Promise<LanguageReviewRow[]> {
  const rows = await prisma.personLanguage.findMany({
    where: languageReviewWhere(),
    orderBy: [{ person: { name: "asc" } }, { language: "asc" }],
    select: {
      id: true,
      personId: true,
      language: true,
      score: true,
      person: { select: { name: true, netId: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    personId: r.personId,
    name: r.person.name,
    netId: r.person.netId,
    language: r.language,
    languageLabel: languageLabel(r.language),
    score: r.score,
  }));
}

/**
 * Record an assessment. Always stamps the assessor and timestamp, so a "no" is
 * still an assessment and the person leaves the queue either way rather than
 * being re-reviewed forever.
 *
 * `score` is tri-state on purpose, because "the form did not ask" and "the
 * reviewer chose N/A" are different facts:
 *
 *   - omitted (undefined) -> leave whatever score is on record alone
 *   - null                -> clear the score
 *   - 1..5                -> set it
 *
 * Writing `input.score ?? null` unconditionally meant the Not-verified button,
 * and every verify from the general queue (neither of which carries a score
 * field), silently erased an assessment someone had already recorded.
 */
export async function recordLanguageAssessment(
  actorPersonId: string,
  input: {
    personId: string;
    language: string;
    verified: boolean;
    note?: string | null;
    score?: number | null;
  },
): Promise<void> {
  if (!isLanguageCode(input.language)) {
    throw new LanguageValidationError(`Unknown language "${input.language}".`);
  }
  if (input.score !== undefined && input.score !== null) {
    if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
      throw new LanguageValidationError(`Score must be 1-5, got "${input.score}".`);
    }
  }
  // The score is a Spanish-only concept (the INTP assessment). A score arriving
  // for any other language is a caller bug, not something to silently drop.
  if (input.score !== undefined && input.score !== null && input.language !== SPANISH) {
    throw new LanguageValidationError(
      `Only ${languageLabel(SPANISH)} carries a proficiency score.`,
    );
  }

  const key = { personId_language: { personId: input.personId, language: input.language } };
  const before = await prisma.personLanguage.findUnique({
    where: key,
    select: { verified: true, verifiedAt: true, score: true },
  });

  const scoreWrite = input.score === undefined ? {} : { score: input.score };

  await prisma.personLanguage.upsert({
    where: key,
    create: {
      personId: input.personId,
      language: input.language,
      verified: input.verified,
      verifiedAt: new Date(),
      verifiedById: actorPersonId,
      note: input.note?.trim() || null,
      ...scoreWrite,
    },
    update: {
      verified: input.verified,
      verifiedAt: new Date(),
      verifiedById: actorPersonId,
      note: input.note?.trim() || null,
      ...scoreWrite,
    },
  });

  // Mirror the decision into the assessment history for the current term, so the
  // history tab and the profile badge agree with what the queue just recorded.
  // Best-effort on the term: with no ACTIVE term there is nothing to file under,
  // and the PersonLanguage row above is still the authoritative current score.
  if (input.language === SPANISH) {
    const activeTerm = await getActiveTerm();
    if (activeTerm) {
      const effectiveScore = input.score === undefined ? (before?.score ?? null) : input.score;
      await upsertSpanishAssessmentForTerm({
        personId: input.personId,
        term: activeTerm.name,
        score: effectiveScore,
        verified: input.verified,
      });
    }
  }

  await recordAudit({
    actorPersonId,
    action: "person.language_assess",
    entityType: "Person",
    entityId: input.personId,
    before: { language: input.language, verified: before?.verified ?? null, score: before?.score ?? null },
    after: {
      language: input.language,
      verified: input.verified,
      score: input.score === undefined ? (before?.score ?? null) : input.score,
    },
  });

  // Tell the member, on BOTH outcomes. A "not confirmed" assessment otherwise
  // leaves the queue silently, and the member goes on believing they are on
  // record as a language provider when they are not. Best-effort: a delivery
  // failure must never roll back or throw out of a committed assessment.
  try {
    await notifyLanguageAssessed(input.personId, input.language, input.verified, input.note ?? null, actorPersonId);
  } catch (err) {
    log.error(
      "[languages] failed to notify a member of their language assessment",
      errorAttrs(err, { personId: input.personId, language: input.language }),
    );
  }
}

async function notifyLanguageAssessed(
  personId: string,
  language: string,
  verified: boolean,
  note: string | null,
  actorPersonId: string,
): Promise<void> {
  const [person, baseUrl] = await Promise.all([
    prisma.person.findUnique({
      where: { id: personId },
      select: { id: true, name: true, entraObjectId: true, contactEmail: true },
    }),
    getSetting<string>("app.baseUrl"),
  ]);
  if (!person) return;

  const label = languageLabel(language);
  const rendered = await renderEmail("volunteers.language_assessed", {
    firstName: firstNameOf(person.name) || "there",
    languageLabel: label,
    verified,
    note: note ?? "",
    hasNote: Boolean(note),
    myInfoLink: `${baseUrl}/my-info`,
  });

  await notify(prisma, {
    type: "volunteers.language_assessed",
    person,
    email: { subject: rendered.subject, html: rendered.html },
    teams: {
      title: `Your ${label} assessment`,
      summary: verified
        ? `The interpreting department confirmed your ${label}.`
        : `The interpreting department reviewed your ${label} and has not confirmed it.`,
      link: `${baseUrl}/my-info`,
    },
    triggeredById: actorPersonId,
  });
}

/**
 * Record a self-reported claim at intake. Never sets verified state.
 *
 * Returns whether this created a NEW claim. Callers use that to decide whether
 * the interpreting department needs telling: re-stating an existing claim on a
 * later application is not news, and notifying on it meant a returning member
 * re-notified every reviewer about a language already on their record.
 *
 * Deliberately does not notify anyone itself. It runs inside the promotion
 * transaction (one call per claimed language, per person), and sending from in
 * there both stretched the transaction across a permission resolution plus N
 * notification writes, and mailed reviewers about promotions that then rolled
 * back. The caller collects the new claims and calls
 * notifyReviewersOfPendingClaims after its transaction commits.
 */
export async function claimLanguage(
  personId: string,
  language: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ created: boolean }> {
  if (!isLanguageCode(language)) {
    throw new LanguageValidationError(`Unknown language "${language}".`);
  }
  const existing = await client.personLanguage.findUnique({
    where: { personId_language: { personId, language } },
    select: { id: true },
  });
  await client.personLanguage.upsert({
    where: { personId_language: { personId, language } },
    create: { personId, language, selfReported: true },
    // Only the claim flag: an existing assessment must survive the person
    // re-stating the claim at a later intake.
    update: { selfReported: true },
  });
  return { created: existing === null };
}

/**
 * Tell the reviewers that new claims are waiting. Call AFTER the transaction
 * that created them has committed.
 *
 * One digest per reviewer rather than one message per claim: promoting a cycle
 * cohort creates dozens of claims at once, and a message each turned a routine
 * promotion into an inbox flood.
 *
 * Best-effort throughout. A delivery failure must never surface as a failed
 * promotion, which has already committed by the time this runs.
 */
export async function notifyReviewersOfPendingClaims(
  claims: Array<{ personId: string; language: string }>,
  triggeredById?: string,
): Promise<void> {
  if (claims.length === 0) return;
  try {
    await sendPendingClaimDigest(claims, triggeredById);
  } catch (err) {
    log.error(
      "[languages] failed to notify reviewers of pending language claims",
      errorAttrs(err, { claimCount: claims.length }),
    );
  }
}

async function sendPendingClaimDigest(
  claims: Array<{ personId: string; language: string }>,
  triggeredById?: string,
): Promise<void> {
  const [reviewers, baseUrl, claimants] = await Promise.all([
    // Resolved through the RBAC engine's own rules: a reviewer whose grant is
    // scoped to the interpreting DEPARTMENT rather than to them personally has
    // no personId on the assignment, and the previous walk over
    // role.assignments[].person skipped every one of them.
    peopleWithPermission("volunteers.verify_spanish"),
    getSetting<string>("app.baseUrl"),
    prisma.person.findMany({
      where: { id: { in: [...new Set(claims.map((c) => c.personId))] } },
      select: { id: true, name: true },
    }),
  ]);
  if (reviewers.length === 0) return;

  const nameById = new Map(claimants.map((p) => [p.id, p.name]));
  const lines = claims
    .map((c) => ({ name: nameById.get(c.personId), language: languageLabel(c.language) }))
    .filter((l): l is { name: string; language: string } => Boolean(l.name))
    .sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
  if (lines.length === 0) return;

  const reviewUrl = `${baseUrl}/volunteers/spanish-review`;
  const summary =
    lines.length === 1
      ? `${lines[0].name} reported speaking ${lines[0].language} and needs assessment.`
      : `${lines.length} volunteers reported speaking a language and need assessment.`;

  await Promise.all(
    reviewers.map(async (reviewer) => {
      const rendered = await renderEmail(
        "volunteers.language_claimed",
        languageClaimedContext({
          firstName: firstNameOf(reviewer.name) || "there",
          claims: lines,
          reviewLink: reviewUrl,
        }),
      );
      await notify(prisma, {
        type: "volunteers.language_claimed",
        person: reviewer,
        email: { subject: rendered.subject, html: rendered.html },
        teams: {
          title: lines.length === 1 ? `New ${lines[0].language} claim` : "New language claims",
          summary,
          link: reviewUrl,
        },
        triggeredById,
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Verified language codes per person, for a set of people. One query, no N+1.
 *
 * VERIFIED only: this is what feeds scheduling, capacity, badges, and the
 * service record, none of which may act on an unassessed claim.
 */
export async function verifiedLanguagesByPerson(
  personIds: string[],
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Map<string, string[]>> {
  if (personIds.length === 0) return new Map();
  const rows = await client.personLanguage.findMany({
    where: { personId: { in: personIds }, verified: true, verifiedAt: { not: null } },
    select: { personId: true, language: true },
    orderBy: { language: "asc" },
  });
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.personId, [...(out.get(r.personId) ?? []), r.language]);
  return out;
}

/**
 * The current INTP Spanish score per person, for a set of people. One query.
 *
 * VERIFIED claims only, matching verifiedLanguagesByPerson: a score attached to
 * a claim nobody has assessed is not a capability. People with no score are
 * absent from the map rather than present with null, so a caller can tell "not
 * scored" from "not a Spanish speaker" only by also consulting the language set.
 *
 * INTERNAL: never render this to the volunteer it describes.
 */
export async function spanishScoresByPerson(
  personIds: string[],
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Map<string, number>> {
  if (personIds.length === 0) return new Map();
  const rows = await client.personLanguage.findMany({
    where: {
      personId: { in: personIds },
      language: SPANISH,
      verified: true,
      verifiedAt: { not: null },
      score: { not: null },
    },
    select: { personId: true, score: true },
  });
  return new Map(rows.map((r) => [r.personId, r.score as number]));
}

/** Every language row for one person, claimed or assessed, for their profile. */
export async function languagesForPerson(personId: string) {
  return prisma.personLanguage.findMany({
    where: { personId },
    orderBy: { language: "asc" },
  });
}

/** Person ids with a verified capability in `language`. */
export async function personIdsVerifiedIn(language: string): Promise<Set<string>> {
  const rows = await prisma.personLanguage.findMany({
    where: { language, verified: true, verifiedAt: { not: null } },
    select: { personId: true },
  });
  return new Set(rows.map((r) => r.personId));
}
