/**
 * One-time backfill of Spanish badges from the imported INTP assessment list.
 *
 * scripts/import-spanish-assessments.ts deliberately writes nothing to
 * PersonLanguage ("verified is decided in Hub by a reviewer, never by the
 * import"), which was right for an import and left every historical decision
 * stranded: 1567 assessment records exist and exactly one person carries a
 * verified Spanish badge. This carries them across.
 *
 * Lives here rather than in the script because nothing under scripts/ is
 * testable, which is the same reason spanish-assessments.ts was lifted out of
 * the review page's server actions.
 */

import { prisma } from "@/platform/db";
import { SPANISH, SPANISH_SPEAKER_MIN_SCORE } from "./catalog";

export type BadgeBackfillOutcome =
  /** Scored at or above the badge floor with no prior assessment. Now verified. */
  | "badged"
  /** Scored below the floor with no prior assessment. Assessed, not verified. */
  | "settled"
  /** A reviewer had already ruled but recorded no number. Score filled in. */
  | "score-filled"
  /** Already assessed and already scored. Untouched. */
  | "unchanged"
  /** Has assessment records, none of which carries a score. Untouched. */
  | "no-score";

export type BadgeBackfillRow = {
  personId: string;
  name: string;
  outcome: BadgeBackfillOutcome;
  score: number | null;
  term: string | null;
};

export type BadgeBackfillReport = {
  rows: BadgeBackfillRow[];
  counts: Record<BadgeBackfillOutcome, number>;
  /**
   * Records with no personId. Informational only: not one of them matches a
   * Person by email, name, or NetID, so there is nothing to link automatically
   * and this module never guesses.
   */
  unlinkedRecords: number;
};

export async function backfillLanguageBadges(
  opts: { dryRun: boolean },
): Promise<BadgeBackfillReport> {
  const unlinkedRecords = await prisma.spanishAssessmentRecord.count({
    where: { personId: null },
  });

  // Every record belonging to an ACTIVE person, newest first. Ordered exactly
  // as latestSpanishAssessment orders, so the backfill and the profile badge
  // can never disagree about which assessment is the current one.
  const records = await prisma.spanishAssessmentRecord.findMany({
    where: { person: { status: "ACTIVE" } },
    orderBy: [{ termRank: "desc" }, { createdAt: "desc" }],
    select: {
      personId: true,
      score: true,
      term: true,
      person: { select: { name: true } },
    },
  });

  // Two facts from one pass: who has any record at all, and each person's most
  // recent record that actually carries a number.
  const seen = new Map<string, string>();
  const latest = new Map<string, { score: number; term: string }>();
  for (const r of records) {
    if (!r.personId || !r.person) continue;
    if (!seen.has(r.personId)) seen.set(r.personId, r.person.name);
    if (r.score === null || latest.has(r.personId)) continue;
    latest.set(r.personId, { score: r.score, term: r.term });
  }

  const existing = await prisma.personLanguage.findMany({
    where: { personId: { in: [...seen.keys()] }, language: SPANISH },
    select: { personId: true, verifiedAt: true, score: true },
  });
  const byPerson = new Map(existing.map((r) => [r.personId, r]));

  const rows: BadgeBackfillRow[] = [];
  const counts: Record<BadgeBackfillOutcome, number> = {
    badged: 0,
    settled: 0,
    "score-filled": 0,
    unchanged: 0,
    "no-score": 0,
  };

  for (const [personId, name] of seen) {
    const record = latest.get(personId);
    if (!record) {
      rows.push({ personId, name, outcome: "no-score", score: null, term: null });
      counts["no-score"] += 1;
      continue;
    }

    const current = byPerson.get(personId);
    const base = { personId, name, score: record.score, term: record.term };

    if (current?.verifiedAt) {
      // A human has ruled. Their verdict stands; only a missing number is
      // additive enough to write.
      if (current.score !== null) {
        rows.push({ ...base, outcome: "unchanged" });
        counts.unchanged += 1;
        continue;
      }
      rows.push({ ...base, outcome: "score-filled" });
      counts["score-filled"] += 1;
      if (!opts.dryRun) {
        await prisma.personLanguage.update({
          where: { personId_language: { personId, language: SPANISH } },
          data: { score: record.score },
        });
      }
      continue;
    }

    const verified = record.score >= SPANISH_SPEAKER_MIN_SCORE;
    rows.push({ ...base, outcome: verified ? "badged" : "settled" });
    counts[verified ? "badged" : "settled"] += 1;
    if (!opts.dryRun) {
      const note = `Recorded from your ${record.term} assessment with the interpreting department.`;
      await prisma.personLanguage.upsert({
        where: { personId_language: { personId, language: SPANISH } },
        create: {
          personId,
          language: SPANISH,
          verified,
          verifiedAt: new Date(),
          score: record.score,
          note,
        },
        // verifiedById stays null: no person made this call, and inventing an
        // actor would misattribute it to whoever ran the script.
        update: { verified, verifiedAt: new Date(), score: record.score, note },
      });
    }
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, counts, unlinkedRecords };
}
