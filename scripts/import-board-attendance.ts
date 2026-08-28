// Imports the board's historical meeting attendance from the workbook ops has
// kept by hand since 2024, "Board Meeting Logistics.xlsx".
//
// Meetings from years that predate the hub get an ARCHIVED term to hang from,
// directors who served before the hub existed get an OFFBOARDED Person row, and
// every mark lands as BoardMeetingAttendance. See
// src/platform/board-attendance/import/index.ts for what is and is not imported.
//
// Dry-run by default. The dry run performs every write inside a transaction it
// then rolls back, so its counts are the counts an apply produces.
//
//   npx tsx --env-file=.env scripts/import-board-attendance.ts "path/to/Board Meeting Logistics.xlsx"
//   npx tsx --env-file=.env scripts/import-board-attendance.ts "path/to/file.xlsx" --apply
//   npx tsx --env-file=.env scripts/import-board-attendance.ts "path/to/file.xlsx" --apply --overwrite
import { parseBoardWorkbook, runBoardAttendanceImport } from "@/platform/board-attendance/import";
import { formatBoardReport } from "@/platform/board-attendance/import/report";

/** Hides credentials while still identifying which database is about to be written. */
function describeDatabase(): string {
  const url = process.env.DATABASE_URL ?? "";
  const match = url.match(/@([^/]+)\/([^?]+)/);
  return match ? `${match[2]} at ${match[1]}` : "(DATABASE_URL not set)";
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const overwriteExisting = args.includes("--overwrite");
  const path = args.find((a) => !a.startsWith("--"));

  if (!path) {
    console.error(
      'Usage: import-board-attendance.ts "<Board Meeting Logistics.xlsx>" [--apply] [--overwrite]',
    );
    process.exit(1);
  }

  const { sheets, missingSheets } = await parseBoardWorkbook(path);
  if (missingSheets.length > 0) {
    // Not fatal on its own: the workbook gains a sheet per year, so an older
    // copy legitimately lacks the newest. Named loudly because the alternative
    // reading is that a sheet was renamed and a year is silently missing.
    console.error(`Sheets not found in this workbook: ${missingSheets.join(", ")}`);
    console.error("");
  }
  if (sheets.length === 0) {
    console.error("No attendance sheets found. Nothing to import.");
    process.exit(1);
  }

  console.log(`Database: ${describeDatabase()}`);
  console.log(apply ? "Apply mode -- writing to database." : "Dry run -- nothing will be written.");
  if (apply && overwriteExisting) {
    console.log("Overwrite mode -- existing marks that differ will be REPLACED.");
  }
  console.log("");

  const report = await runBoardAttendanceImport(sheets, { dryRun: !apply, overwriteExisting });
  console.log(formatBoardReport(report, !apply));

  if (!apply) console.log("\nDry run only. Re-run with --apply to write.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
