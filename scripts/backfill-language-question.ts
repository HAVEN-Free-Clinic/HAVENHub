/**
 * Seed the standard language question into DRAFT recruitment cycles built
 * before it existed, and repair it where it exists in the wrong shape.
 *
 * Dry-run by default; pass --apply to write changes.
 *
 *   npm run backfill:languages:dry
 *   npm run backfill:languages:apply
 *
 * DRAFT cycles only. A cycle that is already OPEN keeps the form its applicants
 * are part-way through; adding the question there is an ops decision, not a
 * backfill. publishCycle will refuse to publish a DRAFT cycle that still lacks
 * the question, so nothing can reach applicants without it.
 */
import { backfillLanguageQuestion } from "@/modules/recruitment/services/language-question";

async function main() {
  const dryRun = !process.argv.includes("--apply");

  console.log(
    dryRun
      ? "DRY RUN -- no changes will be written."
      : "APPLY MODE -- writing to database.",
  );
  console.log();

  const reports = await backfillLanguageQuestion({ dryRun });

  if (reports.length === 0) {
    console.log("No DRAFT cycles found. Nothing to do.");
    return;
  }

  const counts = { added: 0, repaired: 0, "already-correct": 0 };
  for (const r of reports) counts[r.outcome] += 1;

  console.log("=== RESULTS ===");
  console.log(`  ADDED           (question was missing): ${counts.added}`);
  console.log(`  REPAIRED        (wrong type/options):   ${counts.repaired}`);
  console.log(`  ALREADY CORRECT (left alone):           ${counts["already-correct"]}`);
  console.log();

  console.log("--- per cycle ---");
  for (const r of reports) {
    console.log(`  [${r.outcome}] ${r.title}  (${r.cycleId})`);
    console.log(`      section: ${r.sectionTitle}`);
    if (r.legacyRemoved.length > 0) {
      console.log(`      removed legacy free-text fields: ${r.legacyRemoved.join(", ")}`);
    }
    if (r.legacyKeptReason) {
      console.log(`      LEGACY FIELDS KEPT: ${r.legacyKeptReason}`);
    }
  }
  console.log();

  if (dryRun) {
    console.log("Dry run complete. Re-run with --apply to write changes.");
  } else {
    console.log("Backfill applied successfully.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
