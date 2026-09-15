/**
 * Many verdicts from the language review queue in one submit.
 *
 * The queue's per-row form records one assessment at a time, so a reviewer
 * coming out of an assessment session with twenty people to mark had twenty
 * separate clicks and twenty page reloads. This takes the rows they ticked and
 * runs each one through the SAME write that row's own buttons use:
 * recordLanguageAssessment for a member, recordApplicationLanguageAssessment
 * for an applicant. A bulk verdict therefore records nothing a single one would
 * not, with the same audit row, the same history mirror, and the same
 * notification.
 *
 * Not a transaction. Neither single write is one (the member notification is
 * best-effort after the commit), and one bad row must not throw away the
 * verdicts on the rows around it. Each entry succeeds or fails on its own and
 * the page reports the count.
 *
 * Deliberately not re-exported from ./index: this module imports the two write
 * paths from there, and a re-export would make the pair a cycle.
 */
import { log, errorAttrs } from "@/platform/logging";
import { recordLanguageAssessment } from "./index";
import { recordApplicationLanguageAssessment } from "./applicant-review";
import { LanguageValidationError } from "./catalog";
import { normalizeScore } from "./spanish-assessments";

/**
 * One ticked queue row.
 *
 * `score` follows each write path's own rules, because the bulk form posts
 * exactly what the row's own form would:
 *
 *   - member: omitted means the row asked for no score (a non-Spanish
 *     language), which recordLanguageAssessment reads as leave-alone. Present
 *     but blank is the N/A option, which clears it.
 *   - applicant: always a number or null. That write path has no
 *     leave-alone case.
 */
export type BulkAssessmentEntry =
  | { source: "member"; personId: string; language: string; score?: number | null }
  | { source: "applicant"; applicationId: string; language: string; score: number | null };

export type BulkAssessmentResult = {
  recorded: number;
  failed: number;
  /** The first failure a reviewer can act on. Internal errors are logged, not shown. */
  firstError: string | null;
};

const UNREADABLE = "Could not read the selected rows. Reload the page and try again.";

/**
 * Read the `entry` fields the queue's bulk form posts, one JSON object per
 * ticked row.
 *
 * Throws on anything malformed rather than skipping it: a row silently dropped
 * here is a person the reviewer believes they just assessed.
 *
 * Duplicates collapse to one entry. The client cannot post one today, but a
 * repeat would send the member the same notification twice.
 */
export function parseBulkAssessmentEntries(raw: readonly unknown[]): BulkAssessmentEntry[] {
  if (raw.length === 0) {
    throw new LanguageValidationError("Select at least one row first.");
  }

  const entries = new Map<string, BulkAssessmentEntry>();
  for (const value of raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(value));
    } catch {
      throw new LanguageValidationError(UNREADABLE);
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new LanguageValidationError(UNREADABLE);
    }
    const fields = parsed as Record<string, unknown>;
    const language = typeof fields.language === "string" ? fields.language : "";
    if (!language) throw new LanguageValidationError(UNREADABLE);

    if (fields.source === "member" && typeof fields.personId === "string" && fields.personId) {
      entries.set(`member:${fields.personId}:${language}`, {
        source: "member",
        personId: fields.personId,
        language,
        ...("score" in fields ? { score: normalizeScore(fields.score) } : {}),
      });
    } else if (
      fields.source === "applicant" &&
      typeof fields.applicationId === "string" &&
      fields.applicationId
    ) {
      entries.set(`applicant:${fields.applicationId}:${language}`, {
        source: "applicant",
        applicationId: fields.applicationId,
        language,
        score: normalizeScore(fields.score),
      });
    } else {
      throw new LanguageValidationError(UNREADABLE);
    }
  }
  return [...entries.values()];
}

/**
 * Record one verdict, verified or not, on every entry.
 *
 * One at a time rather than in parallel: each write is an upsert, an audit row,
 * and a notification, and a list a human ticked gains nothing from turning that
 * into a burst against the connection pool.
 */
export async function recordLanguageAssessmentsInBulk(
  actorPersonId: string,
  input: { entries: readonly BulkAssessmentEntry[]; verified: boolean },
): Promise<BulkAssessmentResult> {
  let recorded = 0;
  let failed = 0;
  let firstError: string | null = null;

  for (const entry of input.entries) {
    try {
      if (entry.source === "member") {
        await recordLanguageAssessment(actorPersonId, {
          personId: entry.personId,
          language: entry.language,
          verified: input.verified,
          ...(entry.score === undefined ? {} : { score: entry.score }),
        });
      } else {
        await recordApplicationLanguageAssessment(actorPersonId, {
          applicationId: entry.applicationId,
          language: entry.language,
          verified: input.verified,
          score: entry.score,
        });
      }
      recorded++;
    } catch (err) {
      failed++;
      if (err instanceof LanguageValidationError) {
        firstError ??= err.message;
      } else {
        log.error(
          "[languages] a bulk language assessment entry failed",
          errorAttrs(err, { source: entry.source, language: entry.language }),
        );
      }
    }
  }

  return { recorded, failed, firstError };
}

/** The flash the queue shows afterwards: `ok` when every row landed, `error` otherwise. */
export function bulkAssessmentFlash(
  result: BulkAssessmentResult,
  verified: boolean,
): { ok: string } | { error: string } {
  const total = result.recorded + result.failed;
  const outcome = verified ? "verified" : "not verified";
  if (result.failed === 0) {
    return {
      ok: `Recorded ${result.recorded} ${result.recorded === 1 ? "assessment" : "assessments"} as ${outcome}.`,
    };
  }
  const reason = result.firstError ? ` ${result.firstError}` : "";
  return {
    error: `Recorded ${result.recorded} of ${total} as ${outcome}. ${result.failed} could not be recorded.${reason}`,
  };
}
