import type { BoardImportReport } from "./load";

const list = (values: string[]): string => (values.length ? values.join(", ") : "none");

/**
 * Renders the report as plain text for a human to read before authorizing an
 * apply. Every "needs a human" section prints "none" rather than an empty
 * heading, so a clean run reads as visibly clean.
 *
 * The two sections that most deserve a look are the created people (each one is
 * a new row in the directory, so a name that should have matched shows up here)
 * and the applied aliases (each one is a judgement about who a sheet name meant).
 */
export function formatBoardReport(report: BoardImportReport, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(dryRun ? "DRY RUN -- the transaction was rolled back, nothing was written" : "APPLIED -- rows were written");
  lines.push("");

  lines.push("Sheets:");
  for (const sheet of report.sheets) {
    lines.push(
      `  ${sheet.sheet}: ${sheet.rows} rows, ${sheet.marks} marks, ` +
        `${sheet.meetings} meetings (+${sheet.emptyColumns} empty date columns skipped)`,
    );
  }
  lines.push("");

  lines.push("Terms:");
  lines.push(`  created (archived): ${list(report.terms.created)}`);
  lines.push(`  already existed: ${list(report.terms.existing)}`);
  lines.push("");

  lines.push("Meetings:");
  lines.push(`  created: ${report.meetings.created}`);
  lines.push(`  already existed: ${report.meetings.existing}`);
  lines.push("");

  lines.push("People:");
  lines.push(`  matched an existing person: ${report.people.matched}`);
  lines.push(`  created as offboarded: ${report.people.created.length}`);
  for (const name of report.people.created) lines.push(`    ${name}`);
  lines.push("");

  lines.push("Aliases applied (review each one):");
  if (report.people.aliased.length === 0) {
    lines.push("  none");
  } else {
    for (const alias of report.people.aliased) lines.push(`  "${alias.sheet}" -> "${alias.canonical}"`);
  }
  lines.push("");

  lines.push("Ambiguous names, skipped (needs a human):");
  lines.push(`  ${list(report.people.ambiguous)}`);
  lines.push("");

  lines.push("Director memberships:");
  lines.push(`  created: ${report.memberships.created}`);
  lines.push(`  already existed: ${report.memberships.existing}`);
  lines.push(`  not written because the term is live: ${report.memberships.skippedLiveTerm}`);
  lines.push("");

  lines.push("Attendance marks:");
  lines.push(`  created: ${report.attendance.created}`);
  lines.push(`  updated: ${report.attendance.updated}`);
  lines.push(`  already matched: ${report.attendance.unchanged}`);
  lines.push(`  left alone (differs; pass --overwrite to replace): ${report.attendance.keptExisting}`);
  lines.push("");

  lines.push("Unmapped departments (needs a human):");
  lines.push(`  ${list(report.unmappedDepartments)}`);
  lines.push("");

  lines.push("Meeting dates outside every term (needs a human):");
  lines.push(`  ${list(report.unresolvedDates)}`);
  lines.push("");

  lines.push("Unreadable cells (needs a human):");
  if (report.unreadableCells.length === 0) {
    lines.push("  none");
  } else {
    for (const cell of report.unreadableCells) {
      lines.push(`  ${cell.sheet} row ${cell.row} (${cell.name}) ${cell.dateKey}: "${cell.text}"`);
    }
  }
  lines.push("");

  lines.push("Conflicting marks, highest presence kept:");
  if (report.conflicts.length === 0) {
    lines.push("  none");
  } else {
    for (const conflict of report.conflicts) {
      lines.push(
        `  ${conflict.name} on ${conflict.dateKey}: saw ${conflict.saw.map((s) => `"${s}"`).join(" and ")}, kept ${conflict.kept}`,
      );
    }
  }

  return lines.join("\n");
}
