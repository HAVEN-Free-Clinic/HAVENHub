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
import { log, errorAttrs } from "@/platform/logging";

/**
 * Languages the clinic can record. A closed list, not free text: the same
 * language must not appear as "Spanish", "spanish", and "Espanol" across three
 * people, which is exactly what makes a flag unsearchable.
 *
 * Codes are ISO 639-1 where one exists. Add to this list to support another
 * language; existing rows are unaffected.
 */
export const LANGUAGES = [
  { code: "es", label: "Spanish" },
  { code: "zh", label: "Chinese" },
  { code: "ht", label: "Haitian Creole" },
  { code: "pt", label: "Portuguese" },
  { code: "fr", label: "French" },
  { code: "ar", label: "Arabic" },
  { code: "ru", label: "Russian" },
  { code: "vi", label: "Vietnamese" },
  { code: "ko", label: "Korean" },
  { code: "pl", label: "Polish" },
  { code: "it", label: "Italian" },
  { code: "bn", label: "Bengali" },
  { code: "hi", label: "Hindi" },
  { code: "ur", label: "Urdu" },
  { code: "tr", label: "Turkish" },
  { code: "fa", label: "Persian" },
  { code: "sw", label: "Swahili" },
  { code: "am", label: "Amharic" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

/**
 * The application form's language question. Standard across every cycle and
 * guarded at publish, because the answers feed the verification queue and that
 * only works if the question has the same key, type, and options everywhere.
 */
export const LANGUAGES_FIELD_KEY = "languages_spoken";

/**
 * The one definition of that question, imported by everything that writes it:
 * the minimal cycle seed, the application template, and the backfill for cycles
 * built before it existed. Those three each had their own copy at one point and
 * had already drifted on help text, which is the failure this constant prevents.
 *
 * `options` values are language CODES, not labels, so a submitted answer is
 * already the code the verification queue keys on with no label round-trip.
 * Not required: someone who speaks only English answers nothing, and forcing a
 * selection would put noise in the queue.
 */
export const LANGUAGE_QUESTION = {
  key: LANGUAGES_FIELD_KEY,
  label: "Languages you speak fluently, other than English",
  type: "MULTI_SELECT",
  required: false,
  helpText:
    "Select any that apply. The interpreting department will confirm each one with you before you are scheduled as a language provider.",
  options: LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
} as const;

/**
 * The free-text pair the standard question replaced.
 *
 * A typed answer ("some spanish, a little french") cannot be resolved to a
 * language, so these collected data nobody could act on. The backfill removes
 * them rather than leaving them alongside the new question, which would ask an
 * applicant for the same thing twice and still only be able to use one answer.
 */
export const LEGACY_LANGUAGE_FIELD_KEYS = ["other_languages", "other_languages_detail"];

const CODE_BY_LABEL = new Map<string, string>(
  LANGUAGES.map((l) => [l.label.toLowerCase(), l.code]),
);

/**
 * Maps a stored answer back to a language code.
 *
 * Applicants pick LABELS, since "Haitian Creole" is what a person recognizes,
 * but everything downstream keys on the code. Accepts a code directly too, so a
 * re-submitted draft that already stored codes still resolves. Returns null for
 * anything unrecognized rather than inventing a language.
 */
export function languageCodeFromAnswer(answer: string): string | null {
  const v = answer.trim().toLowerCase();
  if (CODE_BY_LABEL.has(v)) return CODE_BY_LABEL.get(v)!;
  return isLanguageCode(v) ? v : null;
}

const LABEL_BY_CODE = new Map<string, string>(LANGUAGES.map((l) => [l.code, l.label]));

export function isLanguageCode(code: string): code is LanguageCode {
  return LABEL_BY_CODE.has(code);
}

/** Human label, falling back to the raw code so a retired code still renders. */
export function languageLabel(code: string): string {
  return LABEL_BY_CODE.get(code) ?? code;
}

export class LanguageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LanguageValidationError";
  }
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

/** True when this claim still needs a human assessment. */
export function needsLanguageReview(row: { verifiedAt: Date | null }): boolean {
  return row.verifiedAt === null;
}

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
};

export async function listLanguageReviewQueue(): Promise<LanguageReviewRow[]> {
  const rows = await prisma.personLanguage.findMany({
    where: languageReviewWhere(),
    orderBy: [{ person: { name: "asc" } }, { language: "asc" }],
    select: {
      id: true,
      personId: true,
      language: true,
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
  }));
}

/**
 * Record an assessment. Always stamps the assessor and timestamp, so a "no" is
 * still an assessment and the person leaves the queue either way rather than
 * being re-reviewed forever.
 */
export async function recordLanguageAssessment(
  actorPersonId: string,
  input: { personId: string; language: string; verified: boolean; note?: string | null },
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
    },
    update: {
      verified: input.verified,
      verifiedAt: new Date(),
      verifiedById: actorPersonId,
      note: input.note?.trim() || null,
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
    firstName: person.name?.trim().split(/\s+/)[0] || person.name || "there",
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
