/**
 * Reading .xlsx workbooks for the attending imports.
 *
 * Kept separate from the parsers so those stay pure and testable against plain
 * arrays, with no file or spreadsheet library in the way.
 */

import ExcelJS from "exceljs";

/**
 * One worksheet as a rectangular array of cell values, header row included.
 *
 * ExcelJS rows are 1-indexed and their `values` array carries a leading hole to
 * match, so the offset is stripped here rather than leaking into every parser.
 * Formula cells hand back `{ result }`, and dates hand back Date objects; both
 * are flattened to what a reader would see.
 */
export function sheetToRows(worksheet: ExcelJS.Worksheet): unknown[][] {
  const rows: unknown[][] = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    rows.push(values.map(flatten));
  });
  return rows;
}

function flatten(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Formula cells, hyperlink cells, and rich text all wrap the readable value.
    if ("result" in obj) return flatten(obj.result);
    if ("text" in obj) return flatten(obj.text);
    if ("richText" in obj && Array.isArray(obj.richText)) {
      return obj.richText.map((r) => (r as { text?: string }).text ?? "").join("");
    }
  }
  return value;
}

/** Load a workbook from disk. */
export async function loadWorkbook(path: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  return workbook;
}

/**
 * A named worksheet, or a clear error naming what the file actually contains.
 *
 * The term sheets are named by hand ("Summer 2026", "Summer 23", "Fall 22"), so
 * a typo is likely and a bare undefined would surface far from the cause.
 */
export function requireSheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) {
    const available = workbook.worksheets.map((w) => w.name).join(", ");
    throw new Error(`Worksheet "${name}" not found. This workbook has: ${available}`);
  }
  return sheet;
}
