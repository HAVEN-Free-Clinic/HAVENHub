// Imports ten closed historical recruitment cycles, plus the interest-form
// source, from Airtable as read-only institutional history. Every write is an
// idempotent upsert (see src/platform/airtable/import/history/load.ts), so
// this is safe to re-run repeatedly while the mapping is tuned.
// Dry-run by default:
//   npx tsx --env-file=.env scripts/import-history.ts
//   npx tsx --env-file=.env scripts/import-history.ts --apply
import { config } from "@/platform/config";
import { AirtableClient, type AirtableRecord } from "@/platform/airtable/client";
import { HISTORY_SOURCES, type HistorySource } from "@/platform/airtable/import/history/sources";
import { loadHistory } from "@/platform/airtable/import/history/load";
import { formatReport } from "@/platform/airtable/import/history/report";
import type { RawHistoryRow, RawInterestRow } from "@/platform/airtable/import/history/types";
import { transformModernVolunteer } from "@/platform/airtable/import/history/adapters/volunteer-modern";
import { transformVolunteerFa24 } from "@/platform/airtable/import/history/adapters/volunteer-fa24";
import { transformVolunteerSu26 } from "@/platform/airtable/import/history/adapters/volunteer-su26";
import { transformDirector } from "@/platform/airtable/import/history/adapters/director";
import { transformInterestForm } from "@/platform/airtable/import/history/adapters/interest-form";

/** Fetches every table named in a source's `tables` map, keyed the same way. */
async function fetchTables(
  client: AirtableClient,
  source: HistorySource,
): Promise<Record<string, AirtableRecord[]>> {
  const entries = await Promise.all(
    Object.entries(source.tables).map(
      async ([key, tableId]) => [key, await client.listAll(source.baseId, tableId)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

/**
 * Dispatches on `source.adapter` to the matching transform. `volunteer-modern`
 * is the one adapter with a flat-array signature (its source has exactly one
 * table, `applications`); every other adapter takes the whole fetched map.
 */
function transform(
  source: HistorySource,
  tables: Record<string, AirtableRecord[]>,
): { rows: RawHistoryRow[]; interests: RawInterestRow[] } {
  switch (source.adapter) {
    case "volunteer-modern":
      return { rows: transformModernVolunteer(tables.applications, source), interests: [] };
    case "volunteer-fa24":
      return { rows: transformVolunteerFa24(tables, source), interests: [] };
    case "volunteer-su26":
      return { rows: transformVolunteerSu26(tables, source), interests: [] };
    case "director":
      return { rows: transformDirector(tables, source), interests: [] };
    case "interest-form":
      return { rows: [], interests: transformInterestForm(tables, source) };
  }
}

async function main() {
  if (!config.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env; the importer needs read access.");
    process.exit(1);
  }
  const dryRun = !process.argv.includes("--apply");

  console.log(dryRun ? "Dry run -- no changes will be written." : "Apply mode -- writing to database.");
  console.log();

  const client = new AirtableClient(config.AIRTABLE_PAT);
  const allRows: RawHistoryRow[] = [];
  const allInterests: RawInterestRow[] = [];

  for (const source of HISTORY_SOURCES) {
    console.log(`Fetching ${source.code} (${source.label})...`);
    const tables = await fetchTables(client, source);
    const { rows, interests } = transform(source, tables);
    allRows.push(...rows);
    allInterests.push(...interests);
  }

  console.log();
  const report = await loadHistory(allRows, allInterests, { dryRun });
  console.log(formatReport(report));
  if (dryRun) console.log("\nDry run only. Re-run with --apply to write.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
