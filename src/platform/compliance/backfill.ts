/**
 * Completion-date backfill for HipaaCertificate rows that have no completionDate.
 *
 * Three extraction strategies (in order):
 *   1. PDF: readFile -> parse -> PARSED extraction
 *   2. Airtable fallback: fetchAirtableDate -> parse text to date -> AIRTABLE extraction
 *   3. None: recorded in the none list, no write
 *
 * In apply mode each successful extraction is written to the DB with an audit
 * log entry (action "compliance.backfill_date", actor null).
 * In dry-run mode no writes occur.
 */

import type { ParsedDate } from "./parser";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackfillDeps = {
  /** Parse a PDF buffer; returns { date } or null. */
  parse: (bytes: Buffer) => Promise<ParsedDate | null>;
  /** Fetch the Airtable AI-generated completion-date text for a record. */
  fetchAirtableDate: (airtableRecordId: string) => Promise<string | null>;
  /** Read the stored cert file by storedName; returns null if missing. */
  readFile: (storedName: string) => Promise<Buffer | null>;
};

export type BackfillOptions = {
  dryRun: boolean;
};

export type BackfillResult = {
  parsed: number;
  airtable: number;
  none: Array<{ certId: string; fileName: string }>;
};

// ---------------------------------------------------------------------------
// Date parsing for Airtable AI text
// ---------------------------------------------------------------------------

const MAX_AGE_YEARS = 5;

/**
 * Accepted date formats in the Airtable AI text field:
 *   YYYY-MM-DD
 *   MM/DD/YYYY
 *   Month D, YYYY  (full or abbreviated month name)
 */
const MONTH_MAP: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

function noonUtc(year: number, month0: number, day: number): Date | null {
  if (month0 < 0 || month0 > 11) return null;
  if (day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month0, day, 12, 0, 0, 0));
  if (d.getUTCMonth() !== month0 || d.getUTCDate() !== day) return null;
  return d;
}

function inSanityWindow(d: Date): boolean {
  const now = new Date();
  if (d.getTime() > now.getTime()) return false;
  const cutoff = new Date(Date.UTC(
    now.getUTCFullYear() - MAX_AGE_YEARS,
    now.getUTCMonth(),
    now.getUTCDate(),
    12, 0, 0, 0,
  ));
  return d.getTime() >= cutoff.getTime();
}

/**
 * Parse a date string from Airtable AI text. Accepts:
 *   YYYY-MM-DD, MM/DD/YYYY, Month D, YYYY
 * Returns noon-UTC Date or null if unparseable / outside sanity window.
 */
export function parseAirtableDateText(text: string): Date | null {
  if (!text) return null;
  const t = text.trim();

  // YYYY-MM-DD
  {
    const m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (m) {
      const d = noonUtc(+m[1], +m[2] - 1, +m[3]);
      if (d && inSanityWindow(d)) return d;
    }
  }

  // MM/DD/YYYY
  {
    const m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
    if (m) {
      const d = noonUtc(+m[3], +m[1] - 1, +m[2]);
      if (d && inSanityWindow(d)) return d;
    }
  }

  // Month D, YYYY  (full or abbreviated)
  {
    const m = t.match(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/i,
    );
    if (m) {
      const month0 = MONTH_MAP[m[1].toLowerCase()];
      if (month0 !== undefined) {
        const d = noonUtc(+m[3], month0, +m[2]);
        if (d && inSanityWindow(d)) return d;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Core backfill logic
// ---------------------------------------------------------------------------

/**
 * Backfill completionDate for every HipaaCertificate that currently has none.
 *
 * In dry-run mode the result counts are populated but no DB writes occur.
 * In apply mode each successful row receives:
 *   - completionDate set to the extracted date
 *   - extraction set to PARSED or AIRTABLE
 *   - an AuditLog row for "compliance.backfill_date"
 */
export async function backfillCompletionDates(
  deps: BackfillDeps,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const { parse, fetchAirtableDate, readFile } = deps;
  const { dryRun } = options;

  // Fetch all certs with no completionDate, plus person's airtableRecordId
  const certs = await prisma.hipaaCertificate.findMany({
    where: { completionDate: null },
    select: {
      id: true,
      fileName: true,
      storedName: true,
      mimeType: true,
      person: { select: { airtableRecordId: true } },
    },
  });

  const result: BackfillResult = { parsed: 0, airtable: 0, none: [] };

  for (const cert of certs) {
    const isPdf = cert.mimeType === "application/pdf";

    let extractedDate: Date | null = null;
    let extraction: "PARSED" | "AIRTABLE" | null = null;

    // Strategy 1: PDF parsing
    if (isPdf) {
      try {
        const bytes = await readFile(cert.storedName);
        if (bytes) {
          const parsed = await parse(bytes);
          if (parsed?.date) {
            extractedDate = parsed.date;
            extraction = "PARSED";
          }
        }
      } catch {
        // fall through to Airtable strategy
      }
    }

    // Strategy 2: Airtable fallback (non-PDF or PDF parse failed)
    if (!extractedDate && cert.person.airtableRecordId) {
      try {
        const text = await fetchAirtableDate(cert.person.airtableRecordId);
        if (text) {
          const d = parseAirtableDateText(text);
          if (d) {
            extractedDate = d;
            extraction = "AIRTABLE";
          }
        }
      } catch {
        // fall through to none
      }
    }

    if (!extractedDate || !extraction) {
      result.none.push({ certId: cert.id, fileName: cert.fileName });
      continue;
    }

    // Increment counter regardless of dryRun
    if (extraction === "PARSED") result.parsed++;
    else result.airtable++;

    if (!dryRun) {
      await prisma.hipaaCertificate.update({
        where: { id: cert.id },
        data: { completionDate: extractedDate, extraction },
      });
      await recordAudit({
        actorPersonId: null,
        action: "compliance.backfill_date",
        entityType: "HipaaCertificate",
        entityId: cert.id,
        after: {
          certId: cert.id,
          extraction,
          completionDate: extractedDate.toISOString(),
        },
      });
    }
  }

  return result;
}
