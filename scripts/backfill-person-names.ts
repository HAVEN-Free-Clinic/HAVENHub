/**
 * Split the free-text `Person.name` column into real name parts.
 *
 * Dry-run by default; pass --apply to write changes.
 *
 *   npm run backfill:names:dry
 *   npm run backfill:names:apply
 *
 * Run this ONCE after the 20260909120000_person_name_parts migration deploys.
 * That migration left every existing row with a crude SQL placeholder and
 * nameNeedsReview = true; this replaces the placeholder with the guarded split
 * in platform/person-name.ts and clears the flag on the rows it can read with
 * confidence.
 *
 * Safe to re-run. A row whose flag has been cleared is a row a human confirmed
 * in /admin/people, and is skipped rather than re-guessed, so a crash leaves a
 * clean prefix written and the next run resumes.
 *
 * Whatever stays FLAGGED at the end is the work list: those people appear in
 * the review queue at /admin/people?names=review until somebody confirms them.
 */
import { backfillPersonNames } from "@/platform/person-name-backfill";

async function main() {
  const dryRun = !process.argv.includes("--apply");

  console.log(
    dryRun ? "DRY RUN -- no changes will be written." : "APPLY MODE -- writing to database.",
  );
  console.log();

  const { rows, counts } = await backfillPersonNames({ dryRun });

  console.log("=== RESULTS ===");
  console.log(`  SPLIT   (read with confidence, flag cleared): ${counts.split}`);
  console.log(`  FLAGGED (a guess, left for review):           ${counts.flagged}`);
  console.log(`  SKIPPED (already confirmed by a human):       ${counts.skipped}`);
  console.log();

  const changed = rows.filter((r) => r.outcome !== "skipped");
  if (changed.length === 0) {
    console.log("Every name is already confirmed. Nothing to do.");
    return;
  }

  console.log("--- per person ---");
  for (const row of changed) {
    const preferred = row.preferredFirstName ? `, goes by ${row.preferredFirstName}` : "";
    const rename = row.before === row.after ? "" : `  ->  ${row.after}`;
    console.log(
      `  [${row.outcome}] ${row.before}${rename}`,
    );
    console.log(`             ${row.legalFirstName} | ${row.lastName}${preferred}`);
  }
  console.log();

  if (counts.flagged > 0) {
    console.log(
      `${counts.flagged} name(s) need a human. Review them at /admin/people?names=review`,
    );
    console.log();
  }

  console.log(
    dryRun
      ? "Dry run complete. Re-run with --apply to write changes."
      : "Backfill applied successfully.",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
