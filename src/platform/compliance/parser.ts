/**
 * HIPAA certificate PDF date parser.
 *
 * Strategy (ordered priority):
 *   0. Transcript-aware handling (runs FIRST): if the text looks like a Workday
 *      multi-course "My Transcript" / Learning History table, restrict to rows
 *      whose course name matches HIPAA-context keywords, take that row's
 *      Completed date (never Enrolled, never the trailing expiration), and
 *      prefer the most recent matching row. A transcript with no HIPAA row
 *      returns null (it is not evidence of HIPAA completion) and does NOT fall
 *      through to the generic label strategies.
 *   1. Labeled completion context: look for text near "completion" keywords and
 *      extract the adjacent date. Hardened to skip column-header windows and to
 *      reject any date immediately preceded by "Enrolled".
 *   2. Multiple formats: Month D, YYYY | MM/DD/YYYY | M/D/YYYY | YYYY-MM-DD |
 *      DD-MMM-YYYY | abbreviated month (Sep 5, 2025).
 *   3. Exclusions: any date found in an expiration-only context is dropped.
 *   4. Sanity window: reject future dates and dates older than 5 years (cutoff
 *      computed at noon UTC).
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
  const now = new Date();
  if (d.getTime() > now.getTime()) return false;
  // Cutoff is exactly MAX_AGE_YEARS ago at NOON UTC, matching the noon-UTC
  // dates produced by noonUtc(). Computing the cutoff at noon UTC (rather than
  // "now minus 5 years" at the current wall-clock time) avoids a sub-day skew
  // that would otherwise make the 5-year edge ambiguous.
  const cutoff = new Date(Date.UTC(
    now.getUTCFullYear() - MAX_AGE_YEARS,
    now.getUTCMonth(),
    now.getUTCDate(),
    12, 0, 0, 0
  ));
  return d.getTime() >= cutoff.getTime();
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

/**
 * If a completion label is *immediately* followed by one of these patterns, it
 * is a table column header (e.g. "...Completion Date and Time Expiration Date
 * Attendance Status...") rather than a labeled value. We anchor at the start of
 * the after-label window so we only reject true header runs, not values that
 * merely happen to be followed by an expiration column later on.
 */
const COLUMN_HEADER_FOLLOWERS = [
  /^\s*Expiration\s+Date\b/i,
  /^\s*and\s+Time\s+Expiration\b/i,
  /^\s*Attendance\s+Status\b/i,
  /^\s*Completion\s+Status\b/i,
];

// ---------------------------------------------------------------------------
// Transcript (Workday "My Transcript" / Learning History) handling
// ---------------------------------------------------------------------------

/**
 * Markers that identify a Workday MULTI-COURSE "My Transcript" PDF. Such PDFs
 * list many courses in a table with one row each of the shape
 * "<Course> Enrolled <date> Completed <date> [<expiration>] ... Enrollment";
 * the naive label-window strategies pick the wrong row, so these are handled
 * first and specially.
 *
 * IMPORTANT: detection must be SPECIFIC. The phrase "Completion Date and Time"
 * also appears as a lesson-table column header on single-course "View Learning
 * Enrollment" detail pages, whose row shape is different ("Completed <score>
 * Passed <date>"). Treating those as transcripts breaks them, so we key off the
 * "My Transcript" page header or the full multi-column transcript table header
 * (which a single-enrollment page never has).
 */
const TRANSCRIPT_MARKERS = [
  /\bMy\s+Transcript\b/i,
  // Full multi-course table header (Date Enrolled ... Completion Date and Time
  // ... Expiration Date), unique to the transcript table.
  /date\s+enrolled\s+completion\s+status\s+completion\s+date\s+and\s+time\s+expiration\s+date/i,
];

/**
 * Course-name keywords that identify a HIPAA-relevant transcript row.
 * Case-insensitive. A transcript with no row matching these is NOT evidence
 * of HIPAA completion (returns null).
 */
const HIPAA_COURSE_KEYWORDS = [
  /hipaa/i,
  /security\s+attestation/i,
  /privacy\s+and\s+security\s+refresher/i,
];

/** True if the text looks like a Workday multi-course transcript. */
function looksLikeTranscript(normalised: string): boolean {
  return TRANSCRIPT_MARKERS.some((rx) => rx.test(normalised));
}

/**
 * Transcript-aware extraction.
 *
 * Each transcript row has the shape:
 *   "<Person> - <CourseName> <CourseName...> <ContentType> Enrolled <MM/DD/YYYY>
 *    Completed <MM/DD/YYYY> <HH:MM:SS> [AM/PM] [<MM/DD/YYYY expiration>] ... Enrollment"
 *
 * We scan every "Completed <date>" occurrence, look back over the row's
 * preceding context (which contains the course name) for HIPAA keywords, take
 * the date immediately after "Completed" (never the Enrolled date, never the
 * trailing expiration date), and keep the most recent such date.
 *
 * Returns:
 *   - ParsedDate when a HIPAA row's Completed date is found
 *   - null when the text is a transcript but has no HIPAA row (caller treats
 *     this as "no evidence" and must NOT fall through to other strategies)
 */
function extractTranscriptDate(normalised: string): ParsedDate | null {
  // Look-back distance to capture the row's course name. Rows repeat the course
  // name twice plus content type before "Enrolled ... Completed", so a generous
  // window is needed; we cap it so we don't bleed into the previous row's data.
  const LOOKBACK = 220;

  const completedRx = /\bCompleted\s+(\d{1,2}\/\d{1,2}\/\d{4})\b/g;
  let best: ParsedDate | null = null;
  let bestTime = -Infinity;

  let m: RegExpExecArray | null;
  while ((m = completedRx.exec(normalised)) !== null) {
    const parsed = parseMDY(m[1]);
    if (!parsed) continue; // out of sanity window or invalid

    // Context preceding this "Completed" token holds the course name.
    const ctxStart = Math.max(0, m.index - LOOKBACK);
    const context = normalised.slice(ctxStart, m.index);

    // Restrict to HIPAA-context rows.
    if (!HIPAA_COURSE_KEYWORDS.some((rx) => rx.test(context))) continue;

    // Prefer the most recent matching Completed date.
    if (parsed[0].getTime() > bestTime) {
      bestTime = parsed[0].getTime();
      best = { date: parsed[0], matchedText: parsed[1] };
    }
  }

  return best;
}

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
  // Strategy 0: Transcript-aware handling (MUST run first)
  // -------------------------------------------------------------------------
  //
  // Workday multi-course "My Transcript" / Learning History PDFs list many
  // courses in a table. The label-window strategies below would match the
  // column HEADER ("Completion Date and Time Expiration Date ...") and return
  // an arbitrary first row's date. Instead, restrict to HIPAA-context rows,
  // take each row's Completed date, and prefer the most recent.
  //
  // If the text is a transcript but has NO HIPAA row, return null directly: a
  // transcript without a HIPAA course is not evidence of HIPAA completion, and
  // we must NOT fall through to the generic strategies (which would otherwise
  // grab some unrelated course's date).
  //
  if (looksLikeTranscript(normalised)) {
    return extractTranscriptDate(normalised);
  }

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
      const windowStart = labelMatch.index + labelMatch[0].length;
      const afterLabel = normalised.slice(windowStart, windowStart + WINDOW);

      // Check that the window is not purely expiration context
      if (EXPIRATION_LABELS.some((rx) => rx.test(afterLabel)) && !COMPLETION_LABELS.some((rx) => rx.test(afterLabel))) {
        continue;
      }

      // Skip column-header windows: a completion label immediately followed by
      // another column label (e.g. "Completion Date and Time" -> "Expiration
      // Date") is a table header, not a labeled value. If the very next tokens
      // are another column label, this is a header and we move on.
      if (COLUMN_HEADER_FOLLOWERS.some((rx) => rx.test(afterLabel))) {
        continue;
      }

      // Try each date format
      const parsers = [parseMDY, parseMonthNameDate, parseISO, parseDMmmY];
      for (const parser of parsers) {
        const result = parser(afterLabel);
        if (!result) continue;
        // Never accept a date whose preceding ~12 chars contain "Enrolled".
        const matchOffsetInWindow = afterLabel.indexOf(result[1]);
        const preceding = afterLabel.slice(
          Math.max(0, matchOffsetInWindow - 12),
          matchOffsetInWindow
        );
        if (/enrolled/i.test(preceding)) continue;
        return { date: result[0], matchedText: result[1] };
      }
    }
  }

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
