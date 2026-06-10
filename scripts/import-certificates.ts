// Live HIPAA certificate backfill from Airtable "All People" attachments.
// Dry-run by default:
//   npx tsx --env-file=.env scripts/import-certificates.ts
//   npx tsx --env-file=.env scripts/import-certificates.ts --apply
import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import { backfillCertificates } from "@/platform/airtable/import/certificates";
import { usingBlobStorage } from "@/platform/storage";

/** Local Postgres hosts where on-disk storage is the legitimate companion. */
const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);

/**
 * Guard against the footgun that orphaned every imported certificate once:
 * running against a REMOTE database (e.g. prod Neon) while storage silently
 * falls back to LOCAL DISK because BLOB_READ_WRITE_TOKEN is unset. The DB rows
 * land in prod, the bytes land on this laptop, and downloads 404 forever.
 */
function assertStorageMatchesDatabase(): void {
  if (usingBlobStorage) return; // Blob is configured -- bytes go where the rows go.
  const dbUrl = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(dbUrl.replace(/^postgres(ql)?:/, "http:")).hostname;
  } catch {
    return; // Unparseable/empty URL -- let the DB client surface its own error.
  }
  if (!LOCAL_DB_HOSTS.has(host)) {
    console.error(
      `Refusing to import: DATABASE_URL points at a remote host (${host}) but ` +
        `BLOB_READ_WRITE_TOKEN is not set, so file bytes would be written to local ` +
        `disk instead of Vercel Blob. Pull the blob token (e.g. \`vercel env pull\`) ` +
        `before applying, or point DATABASE_URL at a local database.`
    );
    process.exit(1);
  }
}

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
  if (!dryRun) assertStorageMatchesDatabase();
  const client = new AirtableClient(config.AIRTABLE_PAT);

  console.log(
    dryRun
      ? "Dry run -- no changes will be written."
      : `Apply mode -- writing to database and ${usingBlobStorage ? "Vercel Blob" : "local disk"}.`
  );
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
