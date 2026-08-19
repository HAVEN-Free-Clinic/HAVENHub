/**
 * ONE-OFF: make the Hub's shift assignments MATCH Airtable, for every department.
 *
 * Why this exists rather than re-running import-schedule.ts: that import is
 * upsert-only. It can add what Airtable gained but never removes what Airtable
 * lost, so a shift dropped in the scheduler keeps its Hub row forever and a swap
 * leaves BOTH people on BOTH dates. Re-running it against the current drift
 * makes the drift worse.
 *
 * This reconciles instead: adds, updates, AND deletes, scoped to the
 * (department, clinic date) pairs Airtable actually describes. A department or
 * date missing from the export is left completely alone.
 *
 * Hub-side work from the last two days wins over Airtable. Three sources, because
 * they fail differently -- see `protectSince` in platform/airtable/import/schedule.ts.
 * The one to keep in mind: approving a drop DELETES the assignment row, so
 * without the request/audit lookups a reconcile would re-create every shift
 * someone was released from today.
 *
 * After this runs, the Hub is the source of truth. Do not run it again: it would
 * revert real Hub edits to whatever Airtable still says.
 *
 * Dry-run by default. ALWAYS read the diff before applying.
 *
 *   npx tsx --env-file=.env scripts/reconcile-schedule.ts
 *   npx tsx --env-file=.env scripts/reconcile-schedule.ts --apply
 *   npx tsx --env-file=.env scripts/reconcile-schedule.ts --since=2026-08-18 --apply
 */
import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import { runScheduleImport } from "@/platform/airtable/import/schedule";

/**
 * Default protection cutoff: 48 hours ago.
 *
 * "Today or yesterday" as a calendar span is at most 48 hours back (23:59 today
 * -> 00:00 yesterday), so this is a superset of it. Erring long is the safe
 * direction: over-protecting leaves a stale row for a human to fix, while
 * under-protecting silently reverts somebody's work.
 */
const DEFAULT_PROTECT_HOURS = 48;

async function main() {
  if (!config.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set; this needs Airtable read access.");
    process.exit(1);
  }

  const dryRun = !process.argv.includes("--apply");
  const sinceArg = process.argv.find((a) => a.startsWith("--since="))?.slice("--since=".length);
  const protectSince = sinceArg
    ? new Date(sinceArg.length === 10 ? `${sinceArg}T00:00:00Z` : sinceArg)
    : new Date(Date.now() - DEFAULT_PROTECT_HOURS * 60 * 60 * 1000);

  if (Number.isNaN(protectSince.getTime())) {
    console.error(`--since is not a valid date: ${sinceArg}`);
    process.exit(1);
  }

  console.log(dryRun ? "DRY RUN -- nothing will be written." : "APPLY -- writing to the database.");
  console.log(`Protecting Hub changes at or after ${protectSince.toISOString()}`);
  console.log();

  const report = await runScheduleImport(new AirtableClient(config.AIRTABLE_PAT), {
    baseId: config.HAVEN_MGMT_BASE_ID,
    scheduleTableId: config.SU26_SCHEDULE_TABLE_ID,
    termCode: "SU26",
    dryRun,
    reconcile: true,
    protectSince,
  });

  console.log(
    `rows ${report.rows}  created ${report.created}  updated ${report.updated}  ` +
      `removed ${report.removed}  unchanged ${report.unchanged}`,
  );

  if (report.removedDetail.length > 0) {
    console.log(`\nREMOVALS (${report.removedDetail.length}) -- read these before applying:`);
    for (const r of [...report.removedDetail].sort((a, b) => a.date.localeCompare(b.date))) {
      console.log(`  ${r.date}  ${r.department.padEnd(6)} ${r.role.padEnd(9)} ${r.personId}`);
    }
  }

  if (report.protectedSkipped.length > 0) {
    console.log(`\nPROTECTED (${report.protectedSkipped.length}) -- recent Hub work, left as-is:`);
    for (const p of [...report.protectedSkipped].sort((a, b) => a.date.localeCompare(b.date))) {
      console.log(`  ${p.date}  ${p.department.padEnd(6)} ${p.reason.padEnd(15)} ${p.personId}`);
    }
  }

  // These mean the reconcile is working from an incomplete picture. An
  // unresolved person or unknown department silently narrows what Airtable is
  // understood to describe, which in reconcile mode also narrows what is
  // protected from deletion -- so they matter more here than on a plain import.
  if (report.unresolvedPeople.length > 0) {
    console.log(`\nWARNING ${report.unresolvedPeople.length} unresolved person record(s); run the people import first.`);
  }
  if (report.unknownDepartments.length > 0) {
    console.log(`\nWARNING unknown departments: ${report.unknownDepartments.join(", ")}`);
  }
  if (report.skippedDates.length > 0) {
    console.log(`\nWARNING dates not in the term's clinic dates: ${report.skippedDates.join(", ")}`);
  }

  if (dryRun) console.log("\nDry run only. Re-run with --apply once the diff above looks right.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    const { prisma } = await import("@/platform/db");
    await prisma.$disconnect();
  });
