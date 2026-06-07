/**
 * HIPAA certificate PDF date parser.
 *
 * Strategy (ordered priority):
 *   1. Labeled completion context: look for text near "completion" keywords and
 *      extract the adjacent date.
 *   2. Multiple formats: Month D, YYYY | MM/DD/YYYY | M/D/YYYY | YYYY-MM-DD |
 *      DD-MMM-YYYY | abbreviated month (Sep 5, 2025).
 *   3. Exclusions: any date found in an expiration-only context is dropped.
 *   4. Sanity window: reject future dates and dates older than 5 years.
 *   5. Returns { date (noon UTC), matchedText } | null.
 *
 * Library: unpdf (wraps pdf.js, no native dependencies, serverless-safe).
 */

import { extractText, getDocumentProxy } from "unpdf";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParsedDate {
  date: Date;
  matchedText: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Month name -> 0-based index map (full and abbreviated). */
const MONTH_MAP: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const MAX_AGE_YEARS = 5;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a noon-UTC Date (avoids timezone day-boundary skew in expiry math).
 * Returns null if values are out of valid range.
 */
function noonUtc(year: number, month0: number, day: number): Date | null {
  if (month0 < 0 || month0 > 11) return null;
  if (day < 1 || day > 31) return null;
  if (year < 1900 || year > 9999) return null;
  const d = new Date(Date.UTC(year, month0, day, 12, 0, 0, 0));
  // Verify no calendar overflow (e.g. Feb 30)
  if (d.getUTCMonth() !== month0 || d.getUTCDate() !== day) return null;
  return d;
}

/** Returns true if the date is within the sanity window (not future, not > 5y old). */
function inSanityWindow(d: Date): boolean {
  const now = Date.now();
  if (d.getTime() > now) return false;
  const fiveYearsAgo = new Date();
  fiveYearsAgo.setUTCFullYear(fiveYearsAgo.getUTCFullYear() - MAX_AGE_YEARS);
  return d.getTime() >= fiveYearsAgo.getTime();
}

// ---------------------------------------------------------------------------
// Date format parsers (return [Date, matched-string] | null)
// ---------------------------------------------------------------------------

type DateMatch = [Date, string] | null;

/** "Month D, YYYY" or "Mon D, YYYY" (e.g. "February 08, 2026" or "Sep 5, 2025") */
function parseMonthNameDate(s: string): DateMatch {
  const rx =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s)) !== null) {
    const month0 = MONTH_MAP[m[1].toLowerCase()];
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    const d = noonUtc(year, month0, day);
    if (d && inSanityWindow(d)) return [d, m[0]];
  }
  return null;
}

/** "MM/DD/YYYY" or "M/D/YYYY" */
function parseMDY(s: string): DateMatch {
  // Match MM/DD/YYYY but not longer sequences that are timestamps (HH:MM:SS etc)
  const rx = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s)) !== null) {
    const month0 = parseInt(m[1], 10) - 1;
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    const d = noonUtc(year, month0, day);
    if (d && inSanityWindow(d)) return [d, m[0]];
  }
  return null;
}

/** "YYYY-MM-DD" */
function parseISO(s: string): DateMatch {
  const rx = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s)) !== null) {
    const year = parseInt(m[1], 10);
    const month0 = parseInt(m[2], 10) - 1;
    const day = parseInt(m[3], 10);
    const d = noonUtc(year, month0, day);
    if (d && inSanityWindow(d)) return [d, m[0]];
  }
  return null;
}

/** "DD-MMM-YYYY" (e.g. "05-Jun-2025") */
function parseDMmmY(s: string): DateMatch {
  const rx =
    /\b(\d{1,2})-(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{4})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s)) !== null) {
    const day = parseInt(m[1], 10);
    const month0 = MONTH_MAP[m[2].toLowerCase()];
    const year = parseInt(m[3], 10);
    const d = noonUtc(year, month0, day);
    if (d && inSanityWindow(d)) return [d, m[0]];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Completion-context labeled matching
// ---------------------------------------------------------------------------

/**
 * Labels that signal a COMPLETION context (case-insensitive).
 * Order matters: more specific first.
 */
const COMPLETION_LABELS = [
  // "Date of Completion" label (appears in cert header; also handles "DATE OF COMPLETION")
  /date\s+of\s+completion/i,
  // "Completion Date" label
  /completion\s+date/i,
  // "Completed on" phrase
  /completed?\s+on/i,
  // "Course completed on:" label
  /course\s+completed\s+on/i,
  // "Completion Moment" (View Learning Enrollment format)
  /completion\s+moment/i,
  // "Initiated On" in the workday event enrollment format (status = Successfully Completed)
  /successfully\s+completed.*?initiated\s+on/is,
  // "Record of Completion ... Date" (short cert format)
  /record\s+of\s+completion/i,
  // Generic "completing" / "completion" followed shortly by date
  /complet(?:ed|ion|ing)/i,
];

/**
 * Labels that signal an EXPIRATION context.
 * Any date that is ONLY next to these (with no preceding completion context)
 * must be rejected.
 */
const EXPIRATION_LABELS = [
  /expir(?:ation|es?|y)/i,
  /valid\s+(?:until|thru|through)/i,
  /valid-until/i,
];

/**
 * Window of characters around a label to search for a date.
 * Larger = more recall; we use 200 chars after the label.
 */
const WINDOW = 200;

// ---------------------------------------------------------------------------
// Core extraction (testable without PDF I/O)
// ---------------------------------------------------------------------------

/**
 * Attempt to extract a completion date from raw text extracted from a PDF.
 *
 * Rules:
 * - Look for completion-context labels and extract the nearest following date.
 * - Never return a date found only in an expiration context.
 * - Apply sanity window (not future, not > 5 years old).
 *
 * Exported for unit testing with synthetic text fixtures.
 */
export function extractDateFromText(text: string): ParsedDate | null {
  if (!text || text.trim().length === 0) return null;

  // Normalise whitespace for easier regex matching
  const normalised = text.replace(/\s+/g, " ").trim();

  // -------------------------------------------------------------------------
  // Strategy A: labeled completion context (high-confidence)
  // -------------------------------------------------------------------------
  //
  // Dominant corpus format: "Month DD, YYYY Authority Date of Completion"
  // The date appears BEFORE the "Date of Completion" label in this format.
  // Handle it specially: look behind the label for a month-name date.
  //
  const certAwardedRx =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}\s+Authority\s+Date\s+of\s+Completion\b/gi;
  let m: RegExpExecArray | null;
  while ((m = certAwardedRx.exec(normalised)) !== null) {
    const parsed = parseMonthNameDate(m[0]);
    if (parsed) return { date: parsed[0], matchedText: parsed[1] };
  }

  // -------------------------------------------------------------------------
  // Strategy B: labeled completion context (forward-looking)
  // -------------------------------------------------------------------------
  //
  // For each completion label found in the text, scan the following WINDOW
  // characters for a date using each format parser.
  //
  for (const labelRx of COMPLETION_LABELS) {
    // We need to find all occurrences; reset regex state
    const searchRx = new RegExp(labelRx.source, labelRx.flags.includes("g") ? labelRx.flags : labelRx.flags + "g");
    let labelMatch: RegExpExecArray | null;
    while ((labelMatch = searchRx.exec(normalised)) !== null) {
      const afterLabel = normalised.slice(labelMatch.index + labelMatch[0].length, labelMatch.index + labelMatch[0].length + WINDOW);

      // Check that the window is not purely expiration context
      if (EXPIRATION_LABELS.some((rx) => rx.test(afterLabel)) && !COMPLETION_LABELS.some((rx) => rx.test(afterLabel))) {
        continue;
      }

      // Try each date format
      const parsers = [parseMDY, parseMonthNameDate, parseISO, parseDMmmY];
      for (const parser of parsers) {
        const result = parser(afterLabel);
        if (result) return { date: result[0], matchedText: result[1] };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Strategy C: Transcript format
  // "Completed MM/DD/YYYY HH:MM:SS [Expiration MM/DD/YYYY]"
  // Look for "Completed" keyword followed immediately by a date.
  // The FIRST date after "Completed" is the completion date;
  // a subsequent date is the expiration date.
  // -------------------------------------------------------------------------
  //
  // Find HIPAA-related "Completed" clauses
  const transcriptRx = /\bCompleted\s+(\d{1,2}\/\d{1,2}\/\d{4})\b/g;
  // We want the one nearest to a HIPAA keyword
  let bestResult: ParsedDate | null = null;
  let bestDistance = Infinity;
  const hipaaIdx = normalised.search(/\bHIPAA\b/i);

  let tm: RegExpExecArray | null;
  while ((tm = transcriptRx.exec(normalised)) !== null) {
    const parsed = parseMDY(tm[1]);
    if (!parsed) continue;

    // The COMPLETION date is the one right after "Completed"; the following date (if any)
    // is the expiration date. Pick the occurrence nearest to the HIPAA keyword.
    const distance = hipaaIdx >= 0 ? Math.abs(tm.index - hipaaIdx) : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestResult = { date: parsed[0], matchedText: tm[1] };
    }
  }
  if (bestResult) return bestResult;

  return null;
}

// ---------------------------------------------------------------------------
// PDF wrapper
// ---------------------------------------------------------------------------

/**
 * Extract the HIPAA training completion date from a PDF buffer.
 *
 * Uses unpdf (wraps pdf.js; pure JS, no native binaries; serverless-safe).
 *
 * @param bytes - Raw PDF file contents as a Buffer.
 * @returns { date, matchedText } at noon UTC, or null if no date found.
 */
export async function extractCompletionDate(
  bytes: Buffer
): Promise<ParsedDate | null> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return extractDateFromText(text);
}
