/**
 * The pre-acceptance half of language review.
 *
 * The interpreting department assesses applicants to certain departments (see
 * Department.assessLanguageBeforeAcceptance) BEFORE an accept decision, because
 * for those departments speaking the language IS the job. Everyone else is
 * assessed after promotion, through the PersonLanguage queue in ./index.
 *
 * Nothing here is written at application submit. The queue is DERIVED from live
 * applications and a verdict is stored only when a reviewer records one, so a
 * withdrawal, a rejection, a reopen, or a deleted application drops out of the
 * queue on its own with no cleanup path to maintain.
 */

import { prisma } from "@/platform/db";
import { SPANISH } from "./catalog";

/** One human verdict on one language, whatever record it came from. */
export type LanguageVerdict = {
  language: string;
  verified: boolean;
  score: number | null;
  note: string | null;
  assessedAt: Date;
  assessedById: string | null;
  source: "member" | "application" | "history";
  /** Set when source is "application". */
  applicationId: string | null;
  /** Set when source is "history": the term label, e.g. "Spring 2025". */
  term: string | null;
};

/** Later verdicts win. Ties keep the incumbent, so the read order does not matter. */
function keepLater(a: LanguageVerdict | undefined, b: LanguageVerdict): LanguageVerdict {
  if (!a) return b;
  return b.assessedAt > a.assessedAt ? b : a;
}

/**
 * Every language on which a human has already assessed these applicants,
 * whatever the outcome, so the queue can skip work that is already done.
 *
 * Identity is resolved the way getApplicantHistory resolves it:
 * Applicant.applicantPersonId when they signed in, Applicant.emailLower
 * otherwise. Three sources, because a verdict can exist in any of them and only
 * one of them is the obvious place:
 *
 *   1. PersonLanguage, for a linked Person. NOT filtered on Person.status: an
 *      offboarded alum reapplying still has their assessment on file, and
 *      languageReviewWhere()'s ACTIVE filter answers a different question
 *      (whose worklist a MEMBER belongs on).
 *   2. ApplicationLanguageAssessment on any application of the same identity,
 *      including the one being queued. This is what stops a rejected applicant
 *      being re-assessed when they reapply next year.
 *   3. SpanishAssessmentRecord linked to the Person, Spanish only.
 *      backfill-language-badges only carried historical scores onto
 *      PersonLanguage for ACTIVE people, so an alum's score is here and nowhere
 *      else.
 */
export async function priorLanguageVerdicts(
  applicantIds: string[],
): Promise<Map<string, Map<string, LanguageVerdict>>> {
  const out = new Map<string, Map<string, LanguageVerdict>>();
  if (applicantIds.length === 0) return out;

  const applicants = await prisma.applicant.findMany({
    where: { id: { in: applicantIds } },
    select: { id: true, emailLower: true, applicantPersonId: true },
  });
  if (applicants.length === 0) return out;
  for (const a of applicants) out.set(a.id, new Map());

  const personIds = [
    ...new Set(applicants.map((a) => a.applicantPersonId).filter((id): id is string => id !== null)),
  ];
  const emails = [...new Set(applicants.map((a) => a.emailLower))];

  const [memberRows, applicationRows, historyRows] = await Promise.all([
    personIds.length === 0
      ? []
      : prisma.personLanguage.findMany({
          where: { personId: { in: personIds }, verifiedAt: { not: null } },
          select: {
            personId: true, language: true, verified: true, score: true,
            note: true, verifiedAt: true, verifiedById: true,
          },
        }),
    prisma.applicationLanguageAssessment.findMany({
      where: {
        application: {
          applicant: {
            OR: [
              { emailLower: { in: emails } },
              ...(personIds.length === 0 ? [] : [{ applicantPersonId: { in: personIds } }]),
            ],
          },
        },
      },
      select: {
        applicationId: true, language: true, verified: true, score: true,
        note: true, verifiedAt: true, verifiedById: true,
        application: { select: { applicant: { select: { emailLower: true, applicantPersonId: true } } } },
      },
    }),
    personIds.length === 0
      ? []
      : prisma.spanishAssessmentRecord.findMany({
          where: { personId: { in: personIds } },
          select: { personId: true, score: true, verified: true, term: true, termRank: true, updatedAt: true },
        }),
  ]);

  const byPerson = new Map<string, string[]>();
  const byEmail = new Map<string, string[]>();
  for (const a of applicants) {
    if (a.applicantPersonId) {
      byPerson.set(a.applicantPersonId, [...(byPerson.get(a.applicantPersonId) ?? []), a.id]);
    }
    byEmail.set(a.emailLower, [...(byEmail.get(a.emailLower) ?? []), a.id]);
  }

  function put(applicantId: string, verdict: LanguageVerdict): void {
    const forApplicant = out.get(applicantId);
    if (!forApplicant) return;
    forApplicant.set(verdict.language, keepLater(forApplicant.get(verdict.language), verdict));
  }

  for (const r of memberRows) {
    for (const applicantId of byPerson.get(r.personId) ?? []) {
      put(applicantId, {
        language: r.language,
        verified: r.verified,
        score: r.score,
        note: r.note,
        // verifiedAt is non-null by the query's own where clause.
        assessedAt: r.verifiedAt as Date,
        assessedById: r.verifiedById,
        source: "member",
        applicationId: null,
        term: null,
      });
    }
  }

  for (const r of applicationRows) {
    const owner = r.application.applicant;
    const targets = new Set([
      ...(owner.applicantPersonId ? (byPerson.get(owner.applicantPersonId) ?? []) : []),
      ...(byEmail.get(owner.emailLower) ?? []),
    ]);
    for (const applicantId of targets) {
      put(applicantId, {
        language: r.language,
        verified: r.verified,
        score: r.score,
        note: r.note,
        assessedAt: r.verifiedAt,
        assessedById: r.verifiedById,
        source: "application",
        applicationId: r.applicationId,
        term: null,
      });
    }
  }

  for (const r of historyRows) {
    if (!r.personId) continue;
    for (const applicantId of byPerson.get(r.personId) ?? []) {
      put(applicantId, {
        language: SPANISH,
        // An imported row with no explicit outcome still records that INTP sat
        // down with this person, which is the fact that spares them a re-assessment.
        verified: r.verified ?? true,
        score: r.score,
        note: null,
        assessedAt: r.updatedAt,
        assessedById: null,
        source: "history",
        applicationId: null,
        term: r.term,
      });
    }
  }

  return out;
}
