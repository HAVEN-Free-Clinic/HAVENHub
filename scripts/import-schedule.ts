// Live SU 26 Schedule import from Airtable into ShiftAssignment rows.
// Dry-run by default:
//   npx tsx --env-file=.env scripts/import-schedule.ts
//   npx tsx --env-file=.env scripts/import-schedule.ts --apply
import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import { runScheduleImport } from "@/platform/airtable/import/schedule";

async function main() {
  if (!config.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env; the schedule import needs read access.");
    process.exit(1);
  }

  const dryRun = !process.argv.includes("--apply");
  const client = new AirtableClient(config.AIRTABLE_PAT);

  console.log(dryRun ? "Dry run -- no changes will be written." : "Apply mode -- writing to database.");
  if (!dryRun) {
    console.log(
      "WARNING: apply overwrites platform-side edits to imported rows (role and tags reset to Airtable values). One-time cutover use only."
    );
  }
  console.log();

  const report = await runScheduleImport(client, {
    baseId: config.HAVEN_MGMT_BASE_ID,
    scheduleTableId: config.SU26_SCHEDULE_TABLE_ID,
    termCode: "SU26",
    dryRun,
  });

  console.log(JSON.stringify(report, null, 2));

  if (dryRun) {
    console.log("\nDry run only. Re-run with --apply to write.");
  }

  if (report.unresolvedPeople.length > 0) {
    console.log(`\n${report.unresolvedPeople.length} unresolved person record(s) -- run the people import first.`);
  }

  if (report.unknownDepartments.length > 0) {
    console.log(`\nUnknown department names: ${report.unknownDepartments.join(", ")}`);
  }

  if (report.skippedDates.length > 0) {
    console.log(`\nSkipped dates not in term clinic dates: ${report.skippedDates.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
