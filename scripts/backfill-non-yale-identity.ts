/**
 * Bring existing recruitment cycles onto the non-Yale-affiliate identity format:
 * gate the Yale NetID on the affiliation answer, relabel the "Yale email" field,
 * and lift the affiliation question above the NetID it controls.
 *
 * Dry-run by default; pass --apply to write changes.
 *
 *   npm run backfill:nonyale:dry
 *   npm run backfill:nonyale:apply
 *
 * Optionally limit to specific cycles:
 *
 *   npm run backfill:nonyale:dry -- --cycle=<id> [--cycle=<id>...]
 *
 * Non-ARCHIVED cycles, including OPEN ones. Unlike the language backfill (which
 * ADDS a required question and so is DRAFT-only), this only ever loosens the
 * form -- it removes a requirement for unaffiliated applicants and relabels a
 * field -- so running it mid-window unblocks people rather than stranding them.
 */
import { backfillNonYaleIdentity } from "@/modules/recruitment/services/non-yale-identity";

async function main() {
  const dryRun = !process.argv.includes("--apply");
  const cycleIds = process.argv
    .filter((a) => a.startsWith("--cycle="))
    .map((a) => a.slice("--cycle=".length));

  console.log(dryRun ? "DRY RUN -- no changes will be written." : "APPLY MODE -- writing to database.");
  if (cycleIds.length > 0) console.log(`Limited to cycles: ${cycleIds.join(", ")}`);
  console.log();

  const reports = await backfillNonYaleIdentity({
    dryRun,
    ...(cycleIds.length > 0 ? { cycleIds } : {}),
  });

  if (reports.length === 0) {
    console.log("No non-archived cycles with an identity form found. Nothing to do.");
    return;
  }

  const changed = reports.filter((r) => r.changes.length > 0);
  console.log("=== RESULTS ===");
  console.log(`  CHANGED         : ${changed.length}`);
  console.log(`  ALREADY CORRECT : ${reports.length - changed.length}`);
  console.log();

  console.log("--- per cycle ---");
  for (const r of reports) {
    const tag = r.changes.length > 0 ? "CHANGED" : "already correct";
    console.log(`  [${tag}] ${r.title}  [${r.status}]  (${r.cycleId})`);
    for (const c of r.changes) console.log(`      - ${c}`);
    if (r.skippedGateReason) console.log(`      NETID GATE SKIPPED: ${r.skippedGateReason}`);
  }
  console.log();

  console.log(dryRun ? "Dry run complete. Re-run with --apply to write changes." : "Backfill applied successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
