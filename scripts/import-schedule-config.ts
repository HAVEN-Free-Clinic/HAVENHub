// Live schedule config import from Airtable: department capacity config.
// Dry-run by default:
//   npx tsx --env-file=.env scripts/import-schedule-config.ts
//   npx tsx --env-file=.env scripts/import-schedule-config.ts --apply
import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import { runScheduleConfigImport } from "@/platform/airtable/import/schedule-config";

async function main() {
  if (!config.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env; the schedule config import needs read access.");
    process.exit(1);
  }

  const dryRun = !process.argv.includes("--apply");
  const client = new AirtableClient(config.AIRTABLE_PAT);

  console.log(dryRun ? "Dry run -- no changes will be written." : "Apply mode -- writing to database.");
  console.log();

  const report = await runScheduleConfigImport(client, {
    baseId: config.HAVEN_MGMT_BASE_ID,
    rosterTableId: config.SU26_ROSTER_TABLE_ID,
    dryRun,
  });

  console.log(JSON.stringify(report, null, 2));

  if (dryRun) {
    console.log("\nDry run only. Re-run with --apply to write.");
  }

  if (report.unknownDepartments.length > 0) {
    console.log(`\nUnknown department codes: ${report.unknownDepartments.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
