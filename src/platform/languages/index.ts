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
import { prisma, type TransactionClient } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { languageClaimedContext } from "@/platform/email/templates/volunteers";
import { getSetting } from "@/platform/settings/service";
import { firstNameOf, personNameOrderVia } from "@/platform/person-name";
import { log, errorAttrs } from "@/platform/logging";
import { getActiveTerm } from "@/platform/terms/active-term";
import { peopleWithPermission } from "@/platform/rbac/permission-holders";
import {
  LanguageValidationError,
  SPANISH,
  isLanguageCode,
  isSpanishScore,
  languageLabel,
} from "./catalog";
import { upsertSpanishAssessmentForTerm, verifyAssessmentRecord } from "./spanish-assessments";
import { listApplicantLanguageQueue } from "./applicant-review";

/**
 * The catalog and its pure helpers are re-exported so every existing server
 * caller can keep importing them from "@/platform/languages". They LIVE in
 * ./catalog because this file imports prisma and notify, and a client component
 * that reached them through here would pull the server graph into the browser
 * bundle and break `next build`. Client components must import ./catalog
 * directly.
 */
export * from "./catalog";
export * from "./applicant-review";

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
  /** PersonLanguage id for a member; `${applicationId}:${language}` for an applicant. */
  id: string;
  source: "member" | "applicant";
  /**
   * Always null on an applicant row. This type never carries an applicant's
   * linked Person, even when one already exists (Applicant.applicantPersonId,
   * set for a signed-in renewal): see the mapping in listLanguageReviewQueue.
   */
  personId: string | null;
  /** Null for a member. */
  applicationId: string | null;
  name: string;
  netId: string | null;
  language: string;
  languageLabel: string;
  score: number | null;
  /** "Fall 2026 Volunteers" for an applicant, the active term name for a member. */
  contextLabel: string;
  /** Department codes. A dual-role offer is rendered as "INTP (dual)". */
  departments: string[];
};

/**
 * One queue, two sources.
 *
 * MEMBERS are claims awaiting assessment, as they always were. This used to
 * split on active-term INTP membership into a scored queue and an unscored
 * "general" one, which meant a Spanish speaker outside interpreting never got a
 * number at all. Do not reintroduce that split.
 *
 * APPLICANTS come from ./applicant-review: people applying to a department that
 * assesses before it accepts. They sort FIRST because they are the ones holding
 * up a decision, and because a member's claim can wait for the next assessment
 * session while an application window cannot.
 */
export async function listLanguageReviewQueue(): Promise<LanguageReviewRow[]> {
  const [applicantRows, memberRowsUnfiltered, activeTerm] = await Promise.all([
    listApplicantLanguageQueue(),
    prisma.personLanguage.findMany({
      where: languageReviewWhere(),
      orderBy: [...personNameOrderVia("person"), { language: "asc" }],
      select: {
        id: true,
        personId: true,
        language: true,
        score: true,
        person: { select: { name: true, netId: true } },
      },
    }),
    getActiveTerm(),
  ]);

  // A signed-in renewal (Applicant.applicantPersonId set) into a lane
  // department can satisfy BOTH sources at once: an ACTIVE member with an
  // unassessed claim who is also an in-lane applicant. A claim is not a
  // verdict, so priorLanguageVerdicts does not suppress them, and without this
  // the reviewer sees two rows for the same (person, language) with two
  // different write paths behind them. Keep the applicant row -- it is the one
  // blocking a decision timeline -- and drop the member row. This only needs
  // to hold while the application is still pending: if it is accepted,
  // carry-forward settles PersonLanguage at promotion; if it is rejected or
  // withdrawn, it drops out of applicantRows (listApplicantLanguageQueue is
  // derived live) and the member row is no longer suppressed on the next read,
  // so it is back in the queue rather than settled by carry-forward.
  const linkedApplicantIds = [...new Set(applicantRows.map((r) => r.applicantId))];
  const linkedApplicants = linkedApplicantIds.length === 0
    ? []
    : await prisma.applicant.findMany({
        where: { id: { in: linkedApplicantIds }, applicantPersonId: { not: null } },
        select: { id: true, applicantPersonId: true },
      });
  const personIdByApplicantId = new Map(
    linkedApplicants.map((a) => [a.id, a.applicantPersonId as string]),
  );
  const suppressedMemberKeys = new Set(
    applicantRows
      .map((r) => {
        const personId = personIdByApplicantId.get(r.applicantId);
        return personId ? `${personId}:${r.language}` : null;
      })
      .filter((k): k is string => k !== null),
  );
  const memberRows = memberRowsUnfiltered.filter(
    (r) => !suppressedMemberKeys.has(`${r.personId}:${r.language}`),
  );

  const memberIds = memberRows.map((r) => r.personId);
  // Department context for the member half. Resolved live from the ACTIVE
  // memberships in the ACTIVE term, matching how every other roster read here
  // resolves a person's departments.
  const memberships = activeTerm
    ? await prisma.termMembership.findMany({
        where: { personId: { in: memberIds }, termId: activeTerm.id, status: "ACTIVE" },
        select: { personId: true, department: { select: { code: true } } },
      })
    : [];
  const deptsByPerson = new Map<string, string[]>();
  for (const m of memberships) {
    deptsByPerson.set(m.personId, [...(deptsByPerson.get(m.personId) ?? []), m.department.code]);
  }

  const applicants: LanguageReviewRow[] = applicantRows.map((r) => ({
    id: `${r.applicationId}:${r.language}`,
    source: "applicant",
    personId: null,
    applicationId: r.applicationId,
    name: r.name,
    netId: r.netId,
    language: r.language,
    languageLabel: languageLabel(r.language),
    score: null,
    contextLabel: r.cycleTitle,
    departments: [...r.departments, ...r.dualRoleDepartments.map((c) => `${c} (dual)`)],
  }));

  const members: LanguageReviewRow[] = memberRows.map((r) => ({
    id: r.id,
    source: "member",
    personId: r.personId,
    applicationId: null,
    name: r.person.name,
    netId: r.person.netId,
    language: r.language,
    languageLabel: languageLabel(r.language),
    score: r.score,
    contextLabel: activeTerm?.name ?? "",
    departments: (deptsByPerson.get(r.personId) ?? []).sort(),
  }));

  return [...applicants, ...members];
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
    if (!isSpanishScore(input.score)) {
      throw new LanguageValidationError(
        `Score must be 1-5 in half steps, got "${input.score}".`,
      );
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

/**
 * Record a reviewer's verdict on ONE row of the assessment history, and let it
 * move the person's live flag only when it is a verdict about their present.
 *
 * TWO FACTS, and the button that used to do this conflated them. A history row
 * carries its own `verified` column, meaning "a reviewer has signed off on this
 * archival record". A person carries PersonLanguage.verified, meaning "this
 * person is on record as a Spanish provider TODAY", and that one gates
 * scheduling, capacity, badges and the passport. The old button was rendered
 * against the first and wrote the second. See verifyAssessmentRecord for the
 * three production defects that produced.
 *
 * THE RULE. The record's own verdict is always written, because that is the row
 * the reviewer was looking at. The live flag follows ONLY when this record is
 * that person's newest, because only then is the reviewer making a statement
 * about the present. Verifying a 2019 row is a statement about 2019: it must not
 * drag a current member's score down to what they scored as a first-year, and
 * un-verifying one must not pull them out of the interpreter pool today.
 *
 * WHEN IT DOES SYNC, it carries the RECORD's score, not null and not the score
 * already on file. The record is the evidence being acted on, so a 5 in the
 * history becomes a 5 on the person. The old path sent no score at all, which
 * silently blanked one.
 *
 * Returns whether the live flag moved, because the reviewer cannot otherwise
 * tell: two rows, one button, and the difference between them is a termRank
 * comparison they cannot see. The page says which happened.
 */
export async function verifyHistoricalAssessment(
  actorPersonId: string,
  input: { recordId: string; verified: boolean },
): Promise<{ liveFlagUpdated: boolean }> {
  const verdict = await verifyAssessmentRecord({ id: input.recordId, verified: input.verified });

  await recordAudit({
    actorPersonId,
    action: "person.language_assess_record",
    entityType: "SpanishAssessmentRecord",
    entityId: input.recordId,
    after: {
      language: SPANISH,
      term: verdict.term,
      verified: input.verified,
      score: verdict.score,
      liveFlagUpdated: verdict.personId !== null && verdict.isNewestForPerson,
    },
  });

  if (!verdict.personId || !verdict.isNewestForPerson) return { liveFlagUpdated: false };

  const key = { personId_language: { personId: verdict.personId, language: SPANISH } };
  const before = await prisma.personLanguage.findUnique({
    where: key,
    select: { verified: true, score: true },
  });

  // Upsert, not update: an alum whose historical record has just been linked may
  // have no PersonLanguage row at all, and creating one is the point of doing
  // this from the history tab. It is the same shape recordLanguageAssessment
  // uses, minus the active-term mirror -- the history row being verified IS the
  // record, so mirroring would be the fabrication this function exists to stop.
  await prisma.personLanguage.upsert({
    where: key,
    create: {
      personId: verdict.personId,
      language: SPANISH,
      verified: input.verified,
      verifiedAt: new Date(),
      verifiedById: actorPersonId,
      score: verdict.score,
    },
    update: {
      verified: input.verified,
      verifiedAt: new Date(),
      verifiedById: actorPersonId,
      score: verdict.score,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "person.language_assess",
    entityType: "Person",
    entityId: verdict.personId,
    before: {
      language: SPANISH,
      verified: before?.verified ?? null,
      score: before?.score ?? null,
    },
    after: { language: SPANISH, verified: input.verified, score: verdict.score },
  });

  // Best-effort, exactly as in recordLanguageAssessment: the verdict is already
  // committed and a delivery failure must not surface as a failed assessment.
  try {
    await notifyLanguageAssessed(verdict.personId, SPANISH, input.verified, null, actorPersonId);
  } catch (err) {
    log.error(
      "[languages] failed to notify a member of their language assessment",
      errorAttrs(err, { personId: verdict.personId, language: SPANISH }),
    );
  }

  return { liveFlagUpdated: true };
}

/**
 * Tell the member. ACTIVE people only.
 *
 * The queue this normally runs behind is already ACTIVE-only
 * (languageReviewWhere), so for a reviewer working the queue this filter never
 * fires. It exists for the OTHER caller: the Verify button on the history tab,
 * which reaches any person a historical assessment row is linked to, including
 * alumni offboarded years ago. That button is for curating a record that runs
 * back to Spring 2012; it is not a message to anybody.
 *
 * It sent one anyway, and the email is the reason to care rather than the record
 * being wrong. An alum who left the clinic got "The interpreting department has
 * confirmed your Spanish... directors will see this when building the clinic
 * schedule", linking to a /my-info they have no reason to open, about a shift
 * they will never be assigned. Every sentence of it is addressed to a current
 * volunteer. There is no version of this template that reads correctly to
 * someone who is not one, which is why this filters rather than branching the
 * copy.
 *
 * The ASSESSMENT is still recorded either way, and must be: linking an alum's
 * historical score to their Hub account is exactly what the history tab is for,
 * and it feeds the passport and the service record. Only the notification is
 * scoped, because only the notification claims the person is still here.
 *
 * Deliberately here rather than in the history action, so the rule holds for any
 * future caller of recordLanguageAssessment. It is the same judgement
 * languageReviewWhere already makes about whose worklist a member belongs on,
 * applied to whose inbox.
 */
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
      select: { id: true, name: true, status: true, entraObjectId: true, contactEmail: true },
    }),
    getSetting<string>("app.baseUrl"),
  ]);
  if (!person) return;
  if (person.status !== "ACTIVE") return;

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
  client: TransactionClient | typeof prisma = prisma,
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
  client: TransactionClient | typeof prisma = prisma,
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
  client: TransactionClient | typeof prisma = prisma,
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
