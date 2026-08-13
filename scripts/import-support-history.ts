// Imports the pre-hub IT Support history from Airtable: the "Tech Requests"
// ticket log and the "YNHH Ticket Tracker", as TechRequest / EpicRequest /
// YnhhTicket rows.
//
// The import never sends anything. It writes through prisma directly, so no
// support service (and therefore no notify() or queueEmail()) is ever reached,
// and it aborts if the EmailLog / TeamsMessage / Notification tables grow while
// it runs. See src/platform/airtable/import/support-history/load.ts.
//
// Dry-run by default; the dry run plans inside a transaction that is rolled
// back, so it exercises the real queries and constraints without writing.
//
//   npx tsx --env-file=.env scripts/import-support-history.ts
//   npx tsx --env-file=.env scripts/import-support-history.ts --apply
//   npx tsx --env-file=.env scripts/import-support-history.ts --apply --skip-attachments
import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import {
  TECH_REQUESTS_TABLE_ID,
  YNHH_TRACKER_TABLE_ID,
} from "@/platform/airtable/fields";
import {
  runSupportHistoryImport,
  SupportHistoryNotificationError,
} from "@/platform/airtable/import/support-history";

/** Hides credentials while still identifying which database is about to be written. */
function describeDatabase(): string {
  const url = process.env.DATABASE_URL ?? "";
  const match = url.match(/@([^/]+)\/([^?]+)/);
  return match ? `${match[2]} at ${match[1]}` : "(DATABASE_URL not set)";
}

async function main() {
  if (!config.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env; the importer needs read access.");
    process.exit(1);
  }
  const dryRun = !process.argv.includes("--apply");
  const skipAttachments = process.argv.includes("--skip-attachments");

  console.log(
    dryRun
      ? "Dry run. Nothing will be written; the plan is rolled back."
      : "APPLY MODE. Writing to the database.",
  );
  console.log(`Database: ${describeDatabase()}`);
  console.log(`Attachments: ${skipAttachments ? "skipped" : "downloaded from Airtable to Blob"}`);
  console.log();

  const client = new AirtableClient(config.AIRTABLE_PAT);
  let report;
  try {
    report = await runSupportHistoryImport(client, {
      baseId: config.HAVEN_MGMT_BASE_ID,
      techRequestsTableId: TECH_REQUESTS_TABLE_ID,
      trackerTableId: YNHH_TRACKER_TABLE_ID,
      dryRun,
      skipAttachments,
    });
  } catch (error) {
    if (error instanceof SupportHistoryNotificationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  console.log(JSON.stringify(report, null, 2));

  if (report.skipped.length > 0) {
    console.log(`\n${report.skipped.length} source row(s) were skipped:`);
    for (const s of report.skipped) console.log(`  [${s.source}] ${s.recordId}: ${s.reason}`);
  }

  if (report.unresolvedTrackerNames.length > 0) {
    console.log(
      `\n${report.unresolvedTrackerNames.length} tracker row(s) name a person the import could ` +
        `not resolve to exactly one Person. The YNHH ticket was still recorded; only the Epic ` +
        `request link was withheld, so these can be linked by hand:`,
    );
    for (const u of report.unresolvedTrackerNames) console.log(`  ${u.recordId}: "${u.text}"`);
  }

  if (report.contentFreeExistingTickets > 0) {
    console.log(
      `\nNote: ${report.contentFreeExistingTickets} YNHH ticket(s) already in the hub have no ` +
        `linked Epic request and no service request number. The import does not touch them; ` +
        `they are worth reviewing separately.`,
    );
  }

  if (report.attachments.failed > 0) {
    console.log(
      `\n${report.attachments.failed} attachment(s) failed to download. Airtable attachment ` +
        `URLs are short-lived, so re-run the import to retry them.`,
    );
  }

  if (dryRun) {
    console.log("\nDry run complete. Re-run with --apply to write.");
  } else {
    console.log(
      `\nImport complete. TechRequest.number now resumes at ${report.nextTechRequestNumber}.`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
