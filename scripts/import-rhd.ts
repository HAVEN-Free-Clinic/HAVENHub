// Live RHD import from Airtable: attending physicians and per-clinic data.
// Dry-run by default:
//   npx tsx --env-file=.env scripts/import-rhd.ts
//   npx tsx --env-file=.env scripts/import-rhd.ts --apply
import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import { runRhdImport } from "@/platform/airtable/import/rhd";

const TERM_CODE = "SU26";

async function main() {
  if (!config.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env; the RHD import needs read access.");
    process.exit(1);
  }

  const dryRun = !process.argv.includes("--apply");
  const client = new AirtableClient(config.AIRTABLE_PAT);

  console.log(dryRun ? "Dry run -- no changes will be written." : "Apply mode -- writing to database.");
  console.log();

  const report = await runRhdImport(client, {
    baseId: config.HAVEN_MGMT_BASE_ID,
    attendingsTableId: config.RHD_ATTENDINGS_TABLE_ID,
    clinicsTableId: config.RHD_CLINICS_TABLE_ID,
    termCode: TERM_CODE,
    dryRun,
  });

  console.log(JSON.stringify(report, null, 2));

  if (dryRun) {
    console.log("\nDry run only. Re-run with --apply to write.");
  }

  if (report.unresolvedAttendings.length > 0) {
    console.log(`\nUnresolved attending record ids: ${report.unresolvedAttendings.join(", ")}`);
  }

  if (report.skippedClinicDates.length > 0) {
    console.log(`\nSkipped clinic dates (not in term): ${report.skippedClinicDates.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
