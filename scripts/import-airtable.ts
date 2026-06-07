// Live import from HAVEN Management into Postgres. Dry-run by default:
//   npx tsx --env-file=.env scripts/import-airtable.ts
//   npx tsx --env-file=.env scripts/import-airtable.ts --apply
import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import { runImport } from "@/platform/airtable/import/importer";

async function main() {
  if (!config.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env; the importer needs read access.");
    process.exit(1);
  }
  const dryRun = !process.argv.includes("--apply");
  const client = new AirtableClient(config.AIRTABLE_PAT);
  const report = await runImport(client, {
    baseId: config.HAVEN_MGMT_BASE_ID,
    peopleTableId: config.ALL_PEOPLE_TABLE_ID,
    rosterTableId: config.SU26_ROSTER_TABLE_ID,
    dryRun,
  });
  console.log(JSON.stringify(report, null, 2));
  if (dryRun) console.log("\nDry run only. Re-run with --apply to write.");
  if (report.people.skipped.length > 0) {
    console.log(`\n${report.people.skipped.length} record(s) skipped; fix in Airtable and re-run.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
