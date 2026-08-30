// Imports one term's attending schedule from the Faculty Relations workbook.
//
// Names in the sheet are informal ("Peggy Bia", "Ami", "Achong", "Dr. Silva"),
// so matching to the roster is best-effort: an exact schedule name, or a unique
// surname. Everything else is REPORTED and left unassigned rather than guessed,
// because a schedule naming the wrong physician is worse than one with gaps.
//
// Run the roster import first, or every name will be unmatched.
//
// Dry-run by default; the dry run resolves every name an apply would.
//
//   npx tsx scripts/import-attending-schedule.ts "sheet.xlsx" --sheet="Summer 2026" --term=SU26
//   npx tsx scripts/import-attending-schedule.ts "sheet.xlsx" --sheet="Summer 2026" --term=SU26 --apply
import { prisma } from "@/platform/db";
import { loadWorkbook, requireSheet, sheetToRows } from "@/platform/attendings/import/workbook";
import { parseTermSchedule, runTermScheduleImport } from "@/platform/attendings/import/schedule";

function describeDatabase(): string {
  const url = process.env.DATABASE_URL ?? "";
  const match = url.match(/@([^/]+)\/([^?]+)/);
  return match ? `${match[2]} at ${match[1]}` : "(DATABASE_URL not set)";
}

function arg(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const path = args.find((a) => !a.startsWith("--"));
  const sheetName = arg(args, "sheet");
  const termCode = arg(args, "term");
  const startYear = Number(arg(args, "year") ?? NaN);

  if (!path || !sheetName || !termCode) {
    console.error(
      'Usage: import-attending-schedule.ts "<file.xlsx>" --sheet="Summer 2026" --term=SU26 [--year=2026] [--apply]',
    );
    process.exit(1);
  }

  const term = await prisma.term.findUnique({
    where: { code: termCode },
    select: { id: true, name: true, startDate: true, clinicDates: true },
  });
  if (!term) {
    console.error(`Term "${termCode}" not found. Import or create the term first.`);
    process.exit(1);
  }

  // The sheet writes month names and day numbers with no year, so it comes from
  // the term unless overridden.
  const year = Number.isInteger(startYear) ? startYear : term.startDate.getUTCFullYear();

  const workbook = await loadWorkbook(path);
  const rows = sheetToRows(requireSheet(workbook, sheetName));
  const parse = parseTermSchedule(rows, { startYear: year });

  console.log(`Database: ${describeDatabase()}`);
  console.log(`Term:     ${term.name} (${termCode}), ${term.clinicDates.length} clinic date(s)`);
  console.log(`Sheet:    "${sheetName}", ${parse.rows.length} dated row(s), year base ${year}\n`);

  const report = await runTermScheduleImport(parse, { termId: term.id, dryRun: !apply });

  console.log(`clinic days created: ${report.daysCreated}`);
  console.log(`clinic days updated: ${report.daysUpdated}`);
  console.log(`assignments written: ${report.assignmentsWritten}`);

  if (report.datesNotInTerm.length > 0) {
    console.log(
      `\n${report.datesNotInTerm.length} sheet date(s) are not clinic dates of this term, so ` +
        `nothing was written for them. Check the term's clinic dates, or --year:`,
    );
    console.log(`  ${report.datesNotInTerm.join(", ")}`);
  }

  if (report.unmatchedColumns.length > 0) {
    console.log(
      `\n${report.unmatchedColumns.length} sheet column(s) match no clinic slot, so their ` +
        `attendings were not imported. Add the column in the Attendings page, or rename it:`,
    );
    for (const c of report.unmatchedColumns) console.log(`  "${c}"`);
  }

  if (report.unmatchedSpecialties.length > 0) {
    console.log(`\n${report.unmatchedSpecialties.length} specialty clinic cell(s) unmatched:`);
    for (const u of report.unmatchedSpecialties) console.log(`  ${u.dateKey}: "${u.text}"`);
  }

  if (report.unmatchedNames.length > 0) {
    const distinct = [...new Set(report.unmatchedNames.map((u) => u.text))].sort();
    console.log(
      `\n${report.unmatchedNames.length} cell name(s) matched no attending, across ` +
        `${distinct.length} distinct name(s). These slots were left UNASSIGNED. Either add the ` +
        `attending to the roster, or set their schedule name to match the sheet:`,
    );
    for (const name of distinct) {
      const where = report.unmatchedNames.filter((u) => u.text === name);
      const suggestions = where[0].suggestions;
      const hint = suggestions.length > 0 ? `  -> did you mean: ${suggestions.join(", ")}` : "";
      console.log(`  "${name}" (${where.length}x, e.g. ${where[0].dateKey} ${where[0].column})${hint}`);
    }
  }

  console.log(apply ? "\nImport complete." : "\nDry run complete. Re-run with --apply to write.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
