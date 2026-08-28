/**
 * Reading the board attendance grid out of "Board Meeting Logistics.xlsx".
 *
 * Every attendance sheet in that workbook has the same shape: two label columns
 * (department, director name) followed by one column per board meeting, headed
 * by the meeting's date, holding "Present" / "Excused" / "Absent" per director.
 *
 * Parsing is kept pure (plain arrays in, plain data out) so it can be tested
 * against the real grid without a database, and so a dry run reports exactly
 * what an apply would write. Nothing here resolves a person, a department, or a
 * term; those are separate steps with their own refusal rules.
 */

import type { BoardAttendanceStatus } from "@prisma/client";

/** One director's mark at one meeting. */
export type ParsedMark = {
  dateKey: string;
  status: BoardAttendanceStatus;
  /** The qualifier the sheet wrote alongside the status, e.g. "illness". */
  note: string | null;
  /** The cell exactly as written, so the report can show what was interpreted. */
  raw: string;
};

/** One row of an attendance sheet. */
export type ParsedRow = {
  sheet: string;
  /** 1-indexed spreadsheet row, so a report line points at the real cell. */
  row: number;
  /** The name as the sheet writes it, whitespace collapsed. */
  name: string;
  /** The department label as the sheet writes it, e.g. "LCC". */
  departmentLabel: string;
  marks: ParsedMark[];
};

export type SheetParse = {
  sheet: string;
  /** Date columns carrying at least one mark, oldest first. */
  dateKeys: string[];
  /**
   * Date columns where nobody was marked. These are meetings that were
   * scheduled but never taken, plus the empty future columns ops pre-fills the
   * current year's sheet with. They deliberately do NOT become meetings: an
   * empty meeting row reads in the UI as "nobody has recorded this yet", which
   * for a 2027 column that does not exist yet is a lie.
   */
  emptyDateKeys: string[];
  /** Header columns that are not dates, e.g. "25-Feb Strategic Retreat". */
  ignoredColumns: string[];
  rows: ParsedRow[];
  /** Cells whose text matched no status, listed rather than guessed at. */
  unreadableCells: Array<{ row: number; name: string; dateKey: string; text: string }>;
};

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

/**
 * One cell's text as a status, or null when it reads as nothing recognizable.
 *
 * The real sheet writes eight distinct spellings across three statuses:
 * "Present", "present", "here", "Absent", "Excused", "Excused (illness)",
 * "Present [Excused after 12:00 PM]", "Present; Excused after 12:30 PM".
 *
 * The two compound spellings resolve to PRESENT, not EXCUSED: the director was
 * at the meeting and left early. Reading them as EXCUSED would be the safe-
 * looking choice and the wrong one, since only ABSENT feeds the strike count
 * and a compound cell is evidence of attendance either way.
 *
 * Anything else returns null and is surfaced in the report. An unrecognized
 * cell is a data question for ops, and the one thing an importer must never do
 * with an attendance record is guess.
 */
export function readStatus(raw: string): { status: BoardAttendanceStatus; note: string | null } | null {
  const value = raw.trim();
  if (value === "") return null;
  const lower = value.toLowerCase();

  // "here" is a one-off spelling from the 2024 sheet, confirmed by its column
  // neighbours all reading "Present" for the same director.
  if (lower === "here") return { status: "PRESENT", note: null };

  for (const [prefix, status] of [
    ["present", "PRESENT"],
    ["excused", "EXCUSED"],
    ["absent", "ABSENT"],
  ] as const) {
    if (!lower.startsWith(prefix)) continue;
    // Whatever follows the status word is the qualifier the sheet wrote:
    // "(illness)", "[Excused after 12:00 PM]", "; Excused after 12:30 PM".
    const rest = value.slice(prefix.length).trim().replace(/^[[(;,:-]+/, "").replace(/[\])]+$/, "").trim();
    return { status, note: rest === "" ? null : rest };
  }
  return null;
}

/**
 * Reads one attendance sheet.
 *
 * `rows` is the sheet as sheetToRows produces it: row 0 is the header, column 0
 * is the department, column 1 is the name, and every remaining column is headed
 * by a Date when it is a meeting.
 */
export function parseAttendanceSheet(sheet: string, rows: unknown[][]): SheetParse {
  const header = rows[0] ?? [];
  const columns: Array<{ index: number; dateKey: string }> = [];
  const ignoredColumns: string[] = [];

  for (let i = 2; i < header.length; i++) {
    const value = header[i];
    if (value instanceof Date) {
      columns.push({ index: i, dateKey: value.toISOString().slice(0, 10) });
      continue;
    }
    const label = text(value);
    if (label !== "") ignoredColumns.push(label);
  }

  const parsed: ParsedRow[] = [];
  const unreadableCells: SheetParse["unreadableCells"] = [];
  const marked = new Set<string>();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const name = text(row[1]);
    if (name === "") continue;
    const departmentLabel = text(row[0]);
    const marks: ParsedMark[] = [];

    for (const column of columns) {
      const raw = text(row[column.index]);
      if (raw === "") continue;
      const read = readStatus(raw);
      if (!read) {
        unreadableCells.push({ row: r + 1, name, dateKey: column.dateKey, text: raw });
        continue;
      }
      marks.push({ dateKey: column.dateKey, status: read.status, note: read.note, raw });
      marked.add(column.dateKey);
    }

    parsed.push({ sheet, row: r + 1, name, departmentLabel, marks });
  }

  return {
    sheet,
    dateKeys: columns.map((c) => c.dateKey).filter((d) => marked.has(d)),
    emptyDateKeys: columns.map((c) => c.dateKey).filter((d) => !marked.has(d)),
    ignoredColumns,
    rows: parsed,
    unreadableCells,
  };
}
