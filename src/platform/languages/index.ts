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
import { getSetting } from "@/platform/settings/service";
import { firstNameOf } from "@/platform/person-name";
import { log, errorAttrs } from "@/platform/logging";
import { LanguageValidationError, isLanguageCode, languageLabel } from "./catalog";

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
  contactEmail: string | null;
  language: string;
  languageLabel: string;
  score: number | null;
};

export async function listLanguageReviewQueue(): Promise<LanguageReviewRow[]> {
  const rows = await prisma.personLanguage.findMany({
    where: languageReviewWhere(),
    orderBy: [{ person: { name: "asc" } }, { language: "asc" }],
    select: {
      id: true,
      personId: true,
      language: true,
      score: true,
      person: { select: { name: true, netId: true, contactEmail: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    personId: r.personId,
    name: r.person.name,
    netId: r.person.netId,
    contactEmail: r.person.contactEmail,
    language: r.language,
    languageLabel: languageLabel(r.language),
    score: r.score,
  }));
}

/**
 * Record an assessment. Always stamps the assessor and timestamp, so a "no" is
 * still an assessment and the person leaves the queue either way rather than
 * being re-reviewed forever.
 */
export async function recordLanguageAssessment(
  actorPersonId: string,
  input: { personId: string; language: string; verified: boolean; note?: string | null; score?: number | null },
): Promise<void> {
  if (!isLanguageCode(input.language)) {
    throw new LanguageValidationError(`Unknown language "${input.language}".`);
  }
  const key = { personId_language: { personId: input.personId, language: input.language } };
  const before = await prisma.personLanguage.findUnique({
    where: key,
    select: { verified: true, verifiedAt: true },
  });

  await prisma.personLanguage.upsert({
    where: key,
    create: {
      personId: input.personId,
      language: input.language,
      verified: input.verified,
      verifiedAt: new Date(),
      verifiedById: actorPersonId,
      note: input.note?.trim() || null,
      score: input.language === "es" ? (input.score ?? null) : null,
    },
    update: {
      verified: input.verified,
      verifiedAt: new Date(),
      verifiedById: actorPersonId,
      note: input.note?.trim() || null,
      score: input.language === "es" ? (input.score ?? null) : null,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "person.language_assess",
    entityType: "Person",
    entityId: input.personId,
    before: { language: input.language, verified: before?.verified ?? null },
    after: { language: input.language, verified: input.verified },
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

/** Record a self-reported claim at intake. Never sets verified state. */
export async function claimLanguage(
  personId: string,
  language: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  if (!isLanguageCode(language)) {
    throw new LanguageValidationError(`Unknown language "${language}".`);
  }
  await client.personLanguage.upsert({
    where: { personId_language: { personId, language } },
    create: { personId, language, selfReported: true },
    // Only the claim flag: an existing assessment must survive the person
    // re-stating the claim at a later intake.
    update: { selfReported: true },
  });
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
