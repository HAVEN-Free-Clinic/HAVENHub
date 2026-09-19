/**
 * Settle what every hand-entered attendee actually owes.
 *
 * Dry-run by default; pass --apply to write changes.
 *
 *   npm run reconcile:attendance:dry
 *   npm run reconcile:attendance:apply
 *
 * Written for the rows the nudge stream can no longer reach. That pass already
 * re-measures rather than replaying each row's snapshot, so an unlinked row
 * whose standing has changed corrects itself on the next tick -- but only while
 * the row is unresolved, under the attempt cap, and on an event inside the
 * lookback window. A row chased to the cap, or on an event older than that
 * window, keeps whatever it was written with. For a waitlisted applicant
 * recorded by hand before the door could list the waitlist, that is a `contract`
 * blocker naming an onboarding form which is minted from an acceptance they do
 * not have.
 *
 * Nothing here sends email. It corrects the record so the clinic is not holding
 * paperwork against somebody it is actually holding a decision about.
 *
 * Writes are per row and sequential, so a crash leaves a clean prefix written
 * and re-running resumes safely: the counts shift from a changed outcome to
 * `unchanged` for whoever was already done. Safe to re-run.
 */
import { reconcileAttendanceStanding } from "@/platform/compliance/attendance-reconcile";

async function main() {
  const dryRun = !process.argv.includes("--apply");

  console.log(
    dryRun ? "DRY RUN -- no changes will be written." : "APPLY MODE -- writing to database.",
  );
  console.log();

  const { rows, counts } = await reconcileAttendanceStanding({ dryRun });

  console.log("=== RESULTS ===");
  console.log(`  RESOLVED  (nothing outstanding; left the stream):  ${counts.resolved}`);
  console.log(`  REOPENED  (owes something again; back in it):      ${counts.reopened}`);
  console.log(`  REWRITTEN (different items, same open/closed):     ${counts.rewritten}`);
  console.log(`  UNCHANGED (already agreed with the record):        ${counts.unchanged}`);
  console.log();

  if (rows.length === 0) {
    console.log("No unlinked attendance rows with an address. Nothing to do.");
    return;
  }

  const changed = rows.filter((r) => r.outcome !== "unchanged");
  if (changed.length === 0) {
    console.log(`All ${rows.length} unlinked rows already agree with their standing.`);
    return;
  }

  console.log("--- rows that change ---");
  for (const r of changed) {
    const who = r.attendeeName ? `${r.attendeeName} <${r.attendeeEmail}>` : r.attendeeEmail;
    const before = r.before.length > 0 ? r.before.join(", ") : "nothing";
    const after = r.after.length > 0 ? r.after.join(", ") : "nothing";
    console.log(`  [${r.outcome}] ${who}  @ ${r.eventTitle}`);
    console.log(`      ${before}  ->  ${after}`);
  }
  console.log();

  console.log(
    dryRun
      ? "Dry run complete. Re-run with --apply to write changes."
      : "Reconcile applied successfully.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
