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

import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { LanguageValidationError, SPANISH, isLanguageCode, languageLabel } from "./catalog";

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

/**
 * Later verdicts win between the member and application sources, which both
 * carry a genuine assessment timestamp and are comparable to each other. Ties
 * keep the incumbent, so the read order does not matter.
 *
 * History does NOT go through this: see the fallback note on source 3 below.
 */
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
 *   3. SpanishAssessmentRecord linked to the Person, Spanish only, and used as
 *      a FALLBACK: it only fills in a language neither source above already
 *      settled. PersonLanguage is the current authoritative record (the badge
 *      backfill copies history INTO it) and ApplicationLanguageAssessment is a
 *      deliberate verdict recorded in this system; a term-granular archival
 *      row must never outrank either on a timestamp. It exists to cover an
 *      alum whose score is here and nowhere else, because
 *      backfill-language-badges only carried historical scores onto
 *      PersonLanguage for ACTIVE people.
 *
 *      Within this source, a person can have one row per term, and a re-import
 *      (scripts/import-spanish-assessments.ts, documented safe to re-run)
 *      upserts, bumping updatedAt on every matching row regardless of which
 *      term it represents. termRank -- not updatedAt -- is the only signal
 *      for which row is the newest term, matching latestSpanishAssessment in
 *      ./spanish-assessments.ts.
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
          // One row per person: the newest TERM, not the newest write. See the
          // fallback note on source 3 above for why updatedAt cannot be used here.
          distinct: ["personId"],
          orderBy: [{ termRank: "desc" }, { createdAt: "desc" }],
          select: { personId: true, score: true, verified: true, term: true, createdAt: true },
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

  /**
   * Fills in a language ONLY when member/application left it unset. Used for
   * history, which must never outrank either on a timestamp (see source 3's
   * doc comment above).
   */
  function putFallback(applicantId: string, verdict: LanguageVerdict): void {
    const forApplicant = out.get(applicantId);
    if (!forApplicant || forApplicant.has(verdict.language)) return;
    forApplicant.set(verdict.language, verdict);
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
      putFallback(applicantId, {
        language: SPANISH,
        // An imported row with no explicit outcome still records that INTP sat
        // down with this person, which is the fact that spares them a re-assessment.
        verified: r.verified ?? true,
        score: r.score,
        note: null,
        // Display only now: putFallback never compares this against another
        // source's timestamp (see source 3's doc comment above). createdAt is
        // when this row entered Hub, the closest thing history has to a stable
        // "assessed at" -- unlike updatedAt it does not get bumped by a
        // same-term re-import. `term` (below) is the actual academic-term label
        // and is what should be shown to a reviewer, not this timestamp.
        assessedAt: r.createdAt,
        assessedById: null,
        source: "history",
        applicationId: null,
        term: r.term,
      });
    }
  }

  return out;
}

/** One (application, language) pair the interpreting department still owes a verdict on. */
export type ApplicantQueueRow = {
  applicationId: string;
  applicantId: string;
  name: string;
  netId: string | null;
  email: string;
  language: string;
  cycleTitle: string;
  /** Routed department first when one is set, then the ranked choices. */
  departments: string[];
  /** Codes offered as a dual role, rendered with a "(dual)" marker. */
  dualRoleDepartments: string[];
};

/**
 * Applications whose department has opted into pre-acceptance assessment, that
 * nobody has decided yet, crossed with the languages still owing a verdict.
 *
 * Spanish is always in the set, claim or no claim: the point of the lane is to
 * confirm Spanish before the department commits, and an applicant who
 * under-reported is exactly the case the assessment exists to catch. Every
 * other language they claimed rides along, because the interpreting department
 * interprets in more than one.
 */
export async function listApplicantLanguageQueue(): Promise<ApplicantQueueRow[]> {
  const laneDepartments = await prisma.department.findMany({
    where: { assessLanguageBeforeAcceptance: true },
    select: { code: true },
  });
  const laneCodes = laneDepartments.map((d) => d.code);
  if (laneCodes.length === 0) return [];

  const applications = await prisma.application.findMany({
    where: {
      status: "SUBMITTED",
      withdrawnAt: null,
      // Undecided, tested twice on purpose. Application.decision carries the
      // routed department's verdict on a VOLUNTEER application, but a
      // DIRECTOR-track application is decided on Interview.decision and leaves
      // Application.decision PENDING forever. Testing only the first would
      // park every decided director applicant here permanently.
      decision: "PENDING",
      // Interview undecided-ness is NOT filtered here. Interview is per
      // (applicationId, departmentCode), and a director applicant can rank
      // into more than one lane department, so "decided" for the queue's
      // purposes means EVERY lane department this application touches has a
      // decided interview, not any single one. That is a set comparison
      // against this application's own department fields, which SQL cannot
      // express as a static clause here; see the post-filter below the query.
      //
      // Deliberately UNSCOPED, unlike interview-undecided-ness above: this query
      // treats ANY Acceptance, in any department, as terminal. A second
      // department CAN still create its own Acceptance later (decideInterview
      // keys its write on (applicationId, departmentCode), not on
      // applicationId), so a multi-department acceptance is possible; when it
      // happens it is a conflict resolved elsewhere (see decisions.ts
      // listConflicts), not something this query adjudicates. A REJECT does
      // not carry that same terminal weight, which is why interview
      // decidedness needs the per-department post-filter below and
      // Acceptance does not.
      acceptances: { none: {} },
      cycle: { status: { not: "ARCHIVED" } },
      OR: [
        { departmentChoices: { hasSome: laneCodes } },
        { dualRoleDepartments: { hasSome: laneCodes } },
        { routedDepartmentCode: { in: laneCodes } },
        // Inclusive OR, kept even though a live submitted RENEWAL already
        // carries this code in departmentChoices too (submissions.ts sets
        // departmentChoices to exactly [renewalDepartment] for a RENEWAL).
        // Nothing in the schema enforces that the two columns stay in
        // lockstep, so this clause is cheap insurance against a row where
        // they diverge, not a guard against a failure mode known to happen
        // under the current write path.
        { renewalDepartment: { in: laneCodes } },
      ],
    },
    select: {
      id: true,
      languagesClaimed: true,
      departmentChoices: true,
      dualRoleDepartments: true,
      routedDepartmentCode: true,
      renewalDepartment: true,
      cycle: { select: { title: true } },
      applicant: { select: { id: true, firstName: true, lastName: true, netId: true, email: true } },
      languageAssessments: { select: { language: true } },
      interviews: { select: { departmentCode: true, decision: true } },
    },
    orderBy: [{ applicant: { lastName: "asc" } }, { applicant: { firstName: "asc" } }, { id: "asc" }],
  });

  /**
   * The lane departments THIS application actually touches, i.e. the same set
   * the OR clause above tested membership against. Every application returned
   * by the query has at least one.
   */
  function ownLaneDepartments(app: (typeof applications)[number]): Set<string> {
    const own = new Set<string>();
    for (const code of [
      ...app.departmentChoices,
      ...app.dualRoleDepartments,
      ...(app.routedDepartmentCode ? [app.routedDepartmentCode] : []),
      ...(app.renewalDepartment ? [app.renewalDepartment] : []),
    ]) {
      if (laneCodes.includes(code)) own.add(code);
    }
    return own;
  }

  const applicationsInQueue = applications.filter((app) => {
    const ownLane = ownLaneDepartments(app);
    // Unreachable in practice, since the OR clause above guarantees membership,
    // but "no lane department" must never read as "decided" -- keep it queued
    // rather than divide by an empty set of departments.
    if (ownLane.size === 0) return true;
    const decidedLane = new Set(
      app.interviews
        .filter((iv) => iv.decision !== "PENDING" && laneCodes.includes(iv.departmentCode))
        .map((iv) => iv.departmentCode),
    );
    // Drop only once EVERY lane department this application touches has
    // decided, not once any one of them has. A department this application
    // never got an Interview row for at all counts as undecided, the same as
    // an explicit PENDING one, so the application stays queued by default.
    const allLaneDecided = [...ownLane].every((code) => decidedLane.has(code));
    return !allLaneDecided;
  });
  if (applicationsInQueue.length === 0) return [];

  const onFile = await priorLanguageVerdicts(applicationsInQueue.map((a) => a.applicant.id));

  const rows: ApplicantQueueRow[] = [];
  for (const app of applicationsInQueue) {
    // Redundant with assessedEver today: priorLanguageVerdicts' source 2 already
    // matches ApplicationLanguageAssessment by this same applicant identity, so
    // it already covers this application's own rows. Kept anyway because
    // priorLanguageVerdicts' name reads as "verdicts from PRIOR applications" --
    // a future rescoping of it under that reading must not silently reopen a
    // language this very application already has a verdict on.
    const assessedHere = new Set(app.languageAssessments.map((a) => a.language));
    const assessedEver = onFile.get(app.applicant.id) ?? new Map<string, LanguageVerdict>();
    const wanted = [SPANISH, ...app.languagesClaimed];

    const routedFirst = [
      ...(app.routedDepartmentCode ? [app.routedDepartmentCode] : []),
      ...(app.renewalDepartment && app.renewalDepartment !== app.routedDepartmentCode
        ? [app.renewalDepartment]
        : []),
      ...app.departmentChoices.filter(
        (c) => c !== app.routedDepartmentCode && c !== app.renewalDepartment,
      ),
    ];

    for (const language of new Set(wanted)) {
      if (assessedHere.has(language)) continue;
      if (assessedEver.has(language)) continue;
      rows.push({
        applicationId: app.id,
        applicantId: app.applicant.id,
        name: `${app.applicant.firstName} ${app.applicant.lastName}`.trim(),
        netId: app.applicant.netId,
        email: app.applicant.email,
        language,
        cycleTitle: app.cycle.title,
        departments: routedFirst,
        dualRoleDepartments: app.dualRoleDepartments,
      });
    }
  }
  return rows;
}

/**
 * Record the interpreting department's verdict on one language for one
 * application. Same validation as recordLanguageAssessment, and deliberately
 * one difference: it notifies nobody.
 *
 * recordLanguageAssessment emails the member and links them to /my-info. An
 * applicant has neither a Person nor a /my-info page, and telling someone their
 * language was "not confirmed" before anyone has decided on their application
 * would land as a rejection they have not received. The outcome reaches them
 * through the acceptance decision instead.
 */
export async function recordApplicationLanguageAssessment(
  actorPersonId: string,
  input: {
    applicationId: string;
    language: string;
    verified: boolean;
    note?: string | null;
    score?: number | null;
  },
): Promise<void> {
  if (!isLanguageCode(input.language)) {
    throw new LanguageValidationError(`Unknown language "${input.language}".`);
  }
  // Unlike recordLanguageAssessment, an omitted score here always means N/A and
  // writes null. That form has two variants and an omitted score there means
  // "did not ask, leave the stored value alone"; this one has a single form
  // that always shows the score field for Spanish, so there is no distinction
  // to preserve between "omitted" and "explicitly cleared".
  const score = input.score ?? null;
  if (score !== null) {
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new LanguageValidationError(`Score must be 1-5, got "${score}".`);
    }
    if (input.language !== SPANISH) {
      throw new LanguageValidationError(
        `Only ${languageLabel(SPANISH)} carries a proficiency score.`,
      );
    }
  }

  const key = {
    applicationId_language: { applicationId: input.applicationId, language: input.language },
  };
  const before = await prisma.applicationLanguageAssessment.findUnique({
    where: key,
    select: { verified: true, score: true },
  });

  await prisma.applicationLanguageAssessment.upsert({
    where: key,
    create: {
      applicationId: input.applicationId,
      language: input.language,
      verified: input.verified,
      verifiedAt: new Date(),
      verifiedById: actorPersonId,
      note: input.note?.trim() || null,
      score,
    },
    update: {
      verified: input.verified,
      verifiedAt: new Date(),
      verifiedById: actorPersonId,
      note: input.note?.trim() || null,
      score,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "application.language_assess",
    entityType: "Application",
    entityId: input.applicationId,
    before: {
      language: input.language,
      verified: before?.verified ?? null,
      score: before?.score ?? null,
    },
    after: { language: input.language, verified: input.verified, score },
  });
}

/**
 * Copy an application's pre-acceptance verdicts onto the person promotion just
 * created, so a member the interpreting department already assessed is never
 * put back in the queue.
 *
 * Preserves the ORIGINAL assessor and timestamp rather than stamping the
 * promoting SRR: the fact being recorded is INTP's assessment, made weeks
 * earlier, and re-stamping it would misattribute an interpreting judgment to
 * whoever happened to run the promotion.
 *
 * Runs inside the promotion transaction, so it takes a client. The Spanish
 * history mirror does NOT: it needs the active term and can fail on its own,
 * and the transaction must not stretch across work like that. The caller does
 * it afterwards, from the returned list.
 *
 * The returned list has TWO consumers with opposite needs, which `written`
 * exists to tell apart:
 *   - promotion's claim loop wants EVERY carried language, written or not, so
 *     it can skip re-claiming a language already on record as assessed.
 *   - the Spanish history mirror wants WRITTEN entries ONLY. `written: false`
 *     means a standing PersonLanguage verdict was already newer than this
 *     application's, so the write below was skipped to protect it; mirroring
 *     that (skipped, stale) entry into history anyway would overwrite a
 *     newer verdict's history row with an older one.
 */
export async function carryForwardApplicationAssessments(
  personId: string,
  applicationId: string,
  client: Prisma.TransactionClient,
): Promise<Array<{ language: string; verified: boolean; score: number | null; written: boolean }>> {
  const assessments = await client.applicationLanguageAssessment.findMany({
    where: { applicationId },
    select: { language: true, verified: true, score: true, note: true, verifiedAt: true, verifiedById: true },
  });
  if (assessments.length === 0) return [];

  const existing = await client.personLanguage.findMany({
    where: { personId, language: { in: assessments.map((a) => a.language) } },
    select: { language: true, verifiedAt: true },
  });
  const standingVerdictAt = new Map(
    existing
      .filter((e) => e.verifiedAt !== null)
      .map((e) => [e.language, e.verifiedAt as Date]),
  );

  const carried: Array<{ language: string; verified: boolean; score: number | null; written: boolean }> = [];
  for (const a of assessments) {
    // A reactivated member may already carry a verdict. Only write when the
    // application's is NEWER, so re-onboarding an alum cannot roll their
    // PersonLanguage record back to an assessment from a previous cycle.
    //
    // Still pushed to `carried` either way, with `written` recording which
    // branch ran: the claim-loop digest consumer wants every carried
    // language (see the docstring above), but a skipped entry must never
    // reach the Spanish history mirror, or it would overwrite a newer
    // standing verdict's history row with the stale one just skipped.
    const standing = standingVerdictAt.get(a.language);
    const written = !(standing && standing >= a.verifiedAt);
    carried.push({ language: a.language, verified: a.verified, score: a.score, written });
    if (!written) continue;

    await client.personLanguage.upsert({
      where: { personId_language: { personId, language: a.language } },
      create: {
        personId,
        language: a.language,
        selfReported: true,
        verified: a.verified,
        verifiedAt: a.verifiedAt,
        verifiedById: a.verifiedById,
        note: a.note,
        score: a.score,
      },
      update: {
        selfReported: true,
        verified: a.verified,
        verifiedAt: a.verifiedAt,
        verifiedById: a.verifiedById,
        note: a.note,
        score: a.score,
      },
    });
  }

  return carried;
}
