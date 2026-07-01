// One-time read-only backfill of EHS completion from the Airtable Compliance table.
//   npx tsx --env-file=.env scripts/import-ehs.ts          (dry run)
//   npx tsx --env-file=.env scripts/import-ehs.ts --apply  (write)

import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import { backfillEhsCompletions } from "@/platform/airtable/import/ehs";
import { COMPLIANCE_TABLE_ID } from "@/platform/airtable/fields";

async function main() {
  if (!config.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env; the importer needs read access.");
    process.exit(1);
  }
  const dryRun = !process.argv.includes("--apply");
  const client = new AirtableClient(config.AIRTABLE_PAT);
  const report = await backfillEhsCompletions(client, {
    baseId: config.HAVEN_MGMT_BASE_ID,
    complianceTableId: COMPLIANCE_TABLE_ID,
    dryRun,
  });
  console.log(JSON.stringify(report, null, 2));
  if (dryRun) console.log("\nDry run only. Re-run with --apply to write.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
