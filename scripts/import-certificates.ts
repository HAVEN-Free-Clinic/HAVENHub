// Live HIPAA certificate backfill from Airtable "All People" attachments.
// Dry-run by default:
//   npx tsx --env-file=.env scripts/import-certificates.ts
//   npx tsx --env-file=.env scripts/import-certificates.ts --apply
import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import { backfillCertificates } from "@/platform/airtable/import/certificates";

async function download(url: string): Promise<Buffer> {
  // Airtable attachment URLs are public-expiring signed URLs -- no auth header needed.
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  if (!config.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env; the backfill needs read access.");
    process.exit(1);
  }

  const dryRun = !process.argv.includes("--apply");
  const client = new AirtableClient(config.AIRTABLE_PAT);

  console.log(dryRun ? "Dry run -- no changes will be written." : "Apply mode -- writing to database and disk.");
  console.log();

  const report = await backfillCertificates(client, download, {
    baseId: config.HAVEN_MGMT_BASE_ID,
    peopleTableId: config.ALL_PEOPLE_TABLE_ID,
    dryRun,
  });

  console.log(JSON.stringify(report, null, 2));

  if (dryRun) {
    console.log("\nDry run only. Re-run with --apply to write.");
  }

  if (report.failures.length > 0) {
    console.log(`\n${report.failures.length} failure(s):`);
    for (const f of report.failures) {
      console.log(`  ${f.recordId}: ${f.reason}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
