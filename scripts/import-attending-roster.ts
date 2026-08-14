// Imports the attending roster from the Faculty Relations contact sheet.
//
// Attendings already in the hub are matched on schedule name and UPDATED; none
// are ever deleted, because a past attending still appears on historical
// schedules. Everything below the sheet's "Removed:" / "Past Attendings:"
// headers lands inactive rather than being skipped.
//
// Dry-run by default. The dry run does every lookup an apply would, so the
// counts and the unresolved lists are the real ones.
//
//   npx tsx scripts/import-attending-roster.ts "path/to/Attending Contact Sheet.xlsx"
//   npx tsx scripts/import-attending-roster.ts "path/to/sheet.xlsx" --apply
import { loadWorkbook, requireSheet, sheetToRows } from "@/platform/attendings/import/workbook";
import { parseAttendingRoster, runAttendingRosterImport } from "@/platform/attendings/import/roster";

/** Hides credentials while still identifying which database is about to be written. */
function describeDatabase(): string {
  const url = process.env.DATABASE_URL ?? "";
  const match = url.match(/@([^/]+)\/([^?]+)/);
  return match ? `${match[2]} at ${match[1]}` : "(DATABASE_URL not set)";
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const path = args.find((a) => !a.startsWith("--"));
  const sheetName = args.find((a) => a.startsWith("--sheet="))?.slice("--sheet=".length) ?? "Sheet1";

  if (!path) {
    console.error('Usage: import-attending-roster.ts "<file.xlsx>" [--sheet=Sheet1] [--apply]');
    process.exit(1);
  }

  const workbook = await loadWorkbook(path);
  const rows = sheetToRows(requireSheet(workbook, sheetName));
  const parse = parseAttendingRoster(rows);

  console.log(`Database: ${describeDatabase()}`);
  console.log(`Sheet "${sheetName}": ${parse.attendings.length} attending row(s) read.\n`);

  const report = await runAttendingRosterImport(parse, { dryRun: !apply });

  console.log(`created:   ${report.created}`);
  console.log(`updated:   ${report.updated}`);
  console.log(`unchanged: ${report.unchanged}`);

  if (report.unmappedSpecialties.length > 0) {
    console.log(
      `\n${report.unmappedSpecialties.length} row(s) name a specialty this import does not ` +
        `recognise. They were imported with NO specialty, so they will not be asked any ` +
        `specialty's qualification questions until it is set by hand:`,
    );
    for (const u of report.unmappedSpecialties) console.log(`  ${u.scheduleName}: "${u.text}"`);
  }

  if (report.duplicateScheduleNames.length > 0) {
    console.log(
      `\n${report.duplicateScheduleNames.length} schedule name(s) are claimed by more than one ` +
        `row. NONE of them were imported, because the schedule identifies an attending by this ` +
        `name and the import must not pick a winner:`,
    );
    for (const d of report.duplicateScheduleNames) {
      console.log(`  "${d.scheduleName}" <- ${d.fullNames.join(" | ")}`);
    }
  }

  if (report.skipped.length > 0) {
    console.log(`\n${report.skipped.length} row(s) skipped:`);
    for (const s of report.skipped) console.log(`  row ${s.row}: ${s.reason} ("${s.text}")`);
  }

  console.log(
    apply ? "\nImport complete." : "\nDry run complete. Re-run with --apply to write.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
