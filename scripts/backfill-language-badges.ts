/**
 * Turn the imported INTP Spanish assessment history into badges.
 *
 * Dry-run by default; pass --apply to write changes.
 *
 *   npm run backfill:langbadges:dry
 *   npm run backfill:langbadges:apply
 *
 * ACTIVE people only, and only from a record that carries a 1-5 score. Never
 * reverses a reviewer's verified verdict -- the "score-filled" path is the
 * only one that touches a row a reviewer already ruled on, and it never
 * writes `verified`. One caveat: that path cannot tell "a reviewer never
 * wrote a number" from "a reviewer deliberately chose the blank N/A option
 * and cleared it," so a re-run refills a deliberately cleared score. Nobody
 * ends up mis-badged either way -- only the number comes back.
 *
 * Writes are per person and sequential, so a crash leaves a clean prefix
 * written and re-running resumes safely: the counts just shift from `badged`
 * to `unchanged` for whoever was already done, while the total stays the
 * same. Safe to re-run.
 */
import { backfillLanguageBadges } from "@/platform/languages/badge-backfill";

async function main() {
  const dryRun = !process.argv.includes("--apply");

  console.log(
    dryRun ? "DRY RUN -- no changes will be written." : "APPLY MODE -- writing to database.",
  );
  console.log();

  const { rows, counts, unlinkedRecords } = await backfillLanguageBadges({ dryRun });

  console.log("=== RESULTS ===");
  console.log(`  BADGED       (scored 3-5, now verified):        ${counts.badged}`);
  console.log(`  SETTLED      (scored 1-2, assessed not verified): ${counts.settled}`);
  console.log(`  SCORE FILLED (reviewer had ruled, no number):   ${counts["score-filled"]}`);
  console.log(`  UNCHANGED    (already assessed and scored):     ${counts.unchanged}`);
  console.log(`  NO SCORE     (records exist, none scored):      ${counts["no-score"]}`);
  console.log();
  console.log(`  Unlinked assessment records (not actionable):   ${unlinkedRecords}`);
  console.log();

  if (rows.length === 0) {
    console.log("No active person has a linked assessment record. Nothing to do.");
    return;
  }

  console.log("--- per person ---");
  for (const r of rows) {
    const score = r.score === null ? "no score" : `score ${r.score}`;
    const term = r.term ? `, ${r.term}` : "";
    console.log(`  [${r.outcome}] ${r.name}  (${score}${term})`);
  }
  console.log();

  console.log(
    dryRun ? "Dry run complete. Re-run with --apply to write changes." : "Backfill applied successfully.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
