// Imports a CLOSED term's roster from Airtable as institutional history.
// The term is created ARCHIVED and is never activated; see
// src/platform/airtable/import/historical-term.ts for why that matters.
// Dry-run by default:
//   npx tsx --env-file=.env scripts/import-historical-term.ts
//   npx tsx --env-file=.env scripts/import-historical-term.ts --apply
import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import { SP26_ROSTER_FIELDS, type RosterFieldIds } from "@/platform/airtable/fields";
import {
  runHistoricalTermImport,
  HistoricalTermNotArchivedError,
  type HistoricalTermSpec,
} from "@/platform/airtable/import/historical-term";

type HistoricalTermSource = {
  spec: HistoricalTermSpec;
  rosterTableId: string;
  rosterFields: RosterFieldIds;
};

/**
 * Past terms available to import, keyed by term code. Dates are noon UTC to
 * match the existing term rows and stay on the intended calendar day in ET.
 */
const SOURCES: Record<string, HistoricalTermSource> = {
  SP26: {
    spec: {
      code: "SP26",
      name: "Spring 2026",
      startDate: new Date("2026-01-12T12:00:00Z"),
      endDate: new Date("2026-05-29T12:00:00Z"),
    },
    rosterTableId: config.SP26_ROSTER_TABLE_ID,
    rosterFields: SP26_ROSTER_FIELDS,
  },
};

async function main() {
  if (!config.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env; the importer needs read access.");
    process.exit(1);
  }
  const dryRun = !process.argv.includes("--apply");
  const requested = process.argv.find((a) => !a.startsWith("--") && SOURCES[a]) ?? "SP26";
  const source = SOURCES[requested];
  if (!source) {
    console.error(`Unknown term "${requested}". Known: ${Object.keys(SOURCES).join(", ")}`);
    process.exit(1);
  }

  console.log(
    dryRun
      ? `Dry run -- no changes will be written. Term: ${requested}`
      : `Apply mode -- writing to database. Term: ${requested}`,
  );
  console.log();

  const client = new AirtableClient(config.AIRTABLE_PAT);
  let report;
  try {
    report = await runHistoricalTermImport(client, {
      baseId: config.HAVEN_MGMT_BASE_ID,
      rosterTableId: source.rosterTableId,
      rosterFields: source.rosterFields,
      term: source.spec,
      dryRun,
    });
  } catch (error) {
    if (error instanceof HistoricalTermNotArchivedError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  console.log(JSON.stringify(report, null, 2));
  if (report.unresolvedPeople.length > 0) {
    console.log(
      `\n${report.unresolvedPeople.length} roster link(s) matched no Person. ` +
        `Run "npm run import:apply" first so every All People record has a row.`,
    );
  }
  if (dryRun) console.log("\nDry run only. Re-run with --apply to write.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
