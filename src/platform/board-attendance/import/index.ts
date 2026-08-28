/**
 * Import of the board's historical meeting attendance from the workbook ops
 * has kept by hand since 2024, "Board Meeting Logistics.xlsx".
 *
 * The workbook holds one attendance grid per year (with two overlapping grids
 * for 2024, where a new sheet took over mid-year). Every grid is the same
 * shape, so they are parsed identically and folded into one plan: a director
 * marked on two sheets for the same meeting is one mark, not two.
 *
 * The hub already owns board attendance -- the models, the recording UI, and
 * the unexcused-absence count the director contract turns into strike evidence.
 * This import backfills the years that predate it. Once it has run, the hub is
 * the record and the workbook is history.
 */

import { prisma } from "@/platform/db";
import { loadWorkbook, requireSheet, sheetToRows } from "@/platform/attendings/import/workbook";
import { parseAttendanceSheet, type SheetParse } from "./parse";
import { loadBoardAttendance, type BoardImportOptions, type BoardImportReport } from "./load";

/**
 * The attendance grids, oldest first.
 *
 * The two 2024 sheets are both included and both real: the first was abandoned
 * in April 2024 and the second picked the year up in May with a different
 * roster. They overlap on eleven marks, which agree, and the fold in load.ts
 * collapses those rather than double-counting them.
 *
 * The workbook's other sheets (presentations, breakout rooms, OPM reviews,
 * working-session notes) are departmental planning material, not a record of
 * who attended, and are deliberately not imported.
 */
export const ATTENDANCE_SHEETS = [
  "Board Meeting- Attendance 2024",
  "Board Attendance - 2024",
  "Board Attendance - 2025",
  "Board Attendance - 2026",
];

export type BoardWorkbookParse = {
  sheets: SheetParse[];
  /** Sheet names asked for that the workbook does not contain. */
  missingSheets: string[];
};

/** Reads and parses every attendance grid in the workbook. */
export async function parseBoardWorkbook(
  path: string,
  sheetNames: string[] = ATTENDANCE_SHEETS,
): Promise<BoardWorkbookParse> {
  const workbook = await loadWorkbook(path);
  const available = new Set(workbook.worksheets.map((w) => w.name));
  const sheets: SheetParse[] = [];
  const missingSheets: string[] = [];

  for (const name of sheetNames) {
    if (!available.has(name)) {
      missingSheets.push(name);
      continue;
    }
    sheets.push(parseAttendanceSheet(name, sheetToRows(requireSheet(workbook, name))));
  }
  return { sheets, missingSheets };
}

/** Raised to abandon the dry run's transaction once its report has been built. */
class Rollback extends Error {
  constructor(public readonly report: BoardImportReport) {
    super("dry run");
    this.name = "Rollback";
  }
}

/**
 * Runs the import.
 *
 * A dry run performs every write the real run would and then rolls the
 * transaction back, so the counts it reports are the counts an apply produces
 * and every constraint has already been tested against real data. The
 * alternative -- a parallel planning path -- is a second implementation of the
 * same logic that can disagree with the one that writes, which on an import
 * this size is exactly the disagreement nobody would notice.
 */
export async function runBoardAttendanceImport(
  sheets: SheetParse[],
  options: BoardImportOptions & { dryRun: boolean },
): Promise<BoardImportReport> {
  const load = { overwriteExisting: options.overwriteExisting };

  if (!options.dryRun) {
    return prisma.$transaction((tx) => loadBoardAttendance(tx, sheets, load), { timeout: 180_000 });
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        throw new Rollback(await loadBoardAttendance(tx, sheets, load));
      },
      { timeout: 180_000 },
    );
  } catch (error) {
    if (error instanceof Rollback) return error.report;
    throw error;
  }
  throw new Error("unreachable: the dry-run transaction must roll back");
}
