/**
 * Imports RHD Attending physicians and per-clinic data from Airtable.
 *
 * AirtableClient.listAll requests returnFieldsByFieldId=true, so record fields
 * are keyed by FIELD ID (e.g. "fld0QTIYF1HHuIqZl"), not display name. The FIELD
 * constants below map semantic names to those real field IDs.
 *
 * Single-select procedure fields arrive as plain strings OR objects with a
 * `.name` property. Normalization: lowercase "yes" -> "yes", "no" -> "no",
 * anything else or absent -> "unknown".
 *
 * The import NEVER deletes existing rows; it only upserts.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { isoDateKey } from "@/platform/dates";
import type { AirtableReader } from "./importer";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RhdImportOptions = {
  baseId: string;
  attendingsTableId: string;
  clinicsTableId: string;
  termCode: string;
  dryRun: boolean;
};

export type RhdImportReport = {
  attendings: { created: number; updated: number; unchanged: number };
  clinics: { created: number; updated: number; unchanged: number };
  /** Deduped raw date values that did not resolve to a term clinic date. */
  skippedClinicDates: string[];
  /** Clinic rows referencing an attending record id not found in the attendings table. */
  unresolvedAttendings: string[];
};

// ---------------------------------------------------------------------------
// RHD Attendings field IDs
// ---------------------------------------------------------------------------

const ATTENDING_FIELD = {
  scheduleName: "fld0QTIYF1HHuIqZl", // Schedule Name
  fullName: "fldkejU9lGynjcHwD",     // Full Name
  iudIn: "fldgAtvQsr32XYzHc",        // IUD In
  iudOut: "fld5CiOguHzJBh44H",       // IUD Out
  nexplanon: "fldJNpizKrDJXlkBq",    // Nexplanon
  gac: "fldXmBJdo8mgBUgHT",          // GAC
  emb: "fldFLKPjXwZ4FQhVe",          // EMB
  seesMale: "fld9rxsLC5VZuyaSx",     // Sees Male
  notes: "fldh1FJjByriGBdb0",        // Notes
} as const;

// ---------------------------------------------------------------------------
// RHD Clinics field IDs
// ---------------------------------------------------------------------------

const CLINIC_FIELD = {
  date: "fldfnW6GCdgXwVztA",          // Date (singleLineText)
  attendingLink: "fldUVqzqrSU4NTlHx", // Attending link (array of record ids)
  director: "fldXCoZq8LKl3a3d2",      // Director on point (text)
  procedures: "fldYIWobbtPV90FM5",    // Procedures Booked (number)
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a single-select field value from Airtable.
 * Accepts plain string OR object with `.name`. Lowercases the result.
 * Only "yes" and "no" are valid; anything else becomes "unknown".
 */
function normalizeSelect(value: unknown): string {
  let raw: unknown = value;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    raw = (raw as Record<string, unknown>).name;
  }
  if (typeof raw === "string") {
    const lower = raw.toLowerCase();
    if (lower === "yes" || lower === "no") return lower;
  }
  return "unknown";
}

/** Read a string field; absent or non-string -> null. */
function strOrNull(fields: Record<string, unknown>, fieldId: string): string | null {
  const v = fields[fieldId];
  if (typeof v === "string" && v.trim().length > 0) return v;
  return null;
}

/** Read a number field; absent or non-number -> null. */
function numberOrNull(fields: Record<string, unknown>, fieldId: string): number | null {
  const v = fields[fieldId];
  if (typeof v === "number" && isFinite(v)) return v;
  return null;
}

// Month name -> 0-based index map
const MONTH_NAMES: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/**
 * Parse a raw clinic date string against the term's clinic dates.
 *
 * Accepts:
 *   - ISO date prefix: "2026-06-06" or "2026-06-06T..."
 *   - Month-name + day with optional ordinal suffix: "June 6th", "june 6"
 *
 * Returns the matching clinicDate Date object, or null if unresolved.
 */
export function parseClinicDate(
  raw: string,
  term: { clinicDates: Date[] }
): Date | null {
  // Build lookup map: isoDateKey -> Date
  const byKey = new Map<string, Date>();
  for (const d of term.clinicDates) {
    byKey.set(isoDateKey(d), d);
  }

  // Try ISO prefix first
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    return byKey.get(isoMatch[1]) ?? null;
  }

  // Try month-name display format: e.g. "June 6th", "june 6", "August 1st"
  // Pattern: <month> <day><optional ordinal suffix>
  const displayMatch = raw.trim().match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/i);
  if (displayMatch) {
    const monthName = displayMatch[1].toLowerCase();
    const day = parseInt(displayMatch[2], 10);
    const monthIndex = MONTH_NAMES[monthName];
    if (monthIndex === undefined) return null;

    // Build a "month day" lookup: "june 6" style keys from clinicDates
    for (const d of term.clinicDates) {
      const m = d.getUTCMonth(); // 0-based
      const dayNum = d.getUTCDate();
      if (m === monthIndex && dayNum === day) {
        return d;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Runs the RHD import: attendings first, then clinics.
 *
 * In apply mode, upserts RhdAttending and RhdClinic rows and writes one
 * AuditLog entry. In dry-run mode, computes the same counts without any DB
 * writes. Dry-run uses a sentinel string as a placeholder attending id so
 * clinic resolution still works correctly.
 */
export async function runRhdImport(
  reader: AirtableReader,
  options: RhdImportOptions
): Promise<RhdImportReport> {
  const report: RhdImportReport = {
    attendings: { created: 0, updated: 0, unchanged: 0 },
    clinics: { created: 0, updated: 0, unchanged: 0 },
    skippedClinicDates: [],
    unresolvedAttendings: [],
  };

  // --- Load term ---
  const term = await prisma.term.findUnique({ where: { code: options.termCode } });
  if (!term) {
    throw new Error(
      `Term with code "${options.termCode}" not found. Run the people/roster import first.`
    );
  }

  // -------------------------------------------------------------------------
  // Phase 1: Attendings
  // -------------------------------------------------------------------------

  const attendingRecords = await reader.listAll(options.baseId, options.attendingsTableId);

  // In-memory map: Airtable record id -> our RhdAttending id (or sentinel in dry-run)
  const attendingIdByRecordId = new Map<string, string>();

  for (const record of attendingRecords) {
    const f = record.fields;
    const scheduleName = strOrNull(f, ATTENDING_FIELD.scheduleName);
    if (!scheduleName) continue; // blank Schedule Name -> skip silently

    const rawFullName = strOrNull(f, ATTENDING_FIELD.fullName);
    const fullName = rawFullName ?? scheduleName;

    const desired = {
      fullName,
      iudIn: normalizeSelect(f[ATTENDING_FIELD.iudIn]),
      iudOut: normalizeSelect(f[ATTENDING_FIELD.iudOut]),
      nexplanon: normalizeSelect(f[ATTENDING_FIELD.nexplanon]),
      gac: normalizeSelect(f[ATTENDING_FIELD.gac]),
      emb: normalizeSelect(f[ATTENDING_FIELD.emb]),
      seesMale: normalizeSelect(f[ATTENDING_FIELD.seesMale]),
      notes: strOrNull(f, ATTENDING_FIELD.notes),
    };

    const existing = await prisma.rhdAttending.findUnique({ where: { scheduleName } });

    if (!existing) {
      report.attendings.created++;
      if (options.dryRun) {
        // Use scheduleName as placeholder key so clinics can still resolve
        attendingIdByRecordId.set(record.id, `dry:${scheduleName}`);
      } else {
        const created = await prisma.rhdAttending.create({
          data: { scheduleName, ...desired },
        });
        attendingIdByRecordId.set(record.id, created.id);
      }
    } else {
      // Check if anything changed
      const changed =
        existing.fullName !== desired.fullName ||
        existing.iudIn !== desired.iudIn ||
        existing.iudOut !== desired.iudOut ||
        existing.nexplanon !== desired.nexplanon ||
        existing.gac !== desired.gac ||
        existing.emb !== desired.emb ||
        existing.seesMale !== desired.seesMale ||
        existing.notes !== desired.notes;

      if (changed) {
        report.attendings.updated++;
        if (!options.dryRun) {
          await prisma.rhdAttending.update({
            where: { scheduleName },
            data: desired,
          });
        }
      } else {
        report.attendings.unchanged++;
      }

      attendingIdByRecordId.set(record.id, existing.id);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: Clinics
  // -------------------------------------------------------------------------

  const clinicRecords = await reader.listAll(options.baseId, options.clinicsTableId);

  for (const record of clinicRecords) {
    const f = record.fields;

    // Resolve date
    const rawDate = typeof f[CLINIC_FIELD.date] === "string"
      ? (f[CLINIC_FIELD.date] as string)
      : null;

    if (!rawDate) {
      // No date field; skip without adding to skipped list
      continue;
    }

    const clinicDate = parseClinicDate(rawDate, term);
    if (!clinicDate) {
      if (!report.skippedClinicDates.includes(rawDate)) {
        report.skippedClinicDates.push(rawDate);
      }
      continue;
    }

    // Resolve attending link: use first id in array
    const attendingLinks = Array.isArray(f[CLINIC_FIELD.attendingLink])
      ? (f[CLINIC_FIELD.attendingLink] as unknown[]).filter((v): v is string => typeof v === "string")
      : [];

    let attendingId: string | null = null;
    if (attendingLinks.length > 0) {
      const firstLink = attendingLinks[0];
      const resolvedId = attendingIdByRecordId.get(firstLink);
      if (resolvedId !== undefined) {
        // In dry-run the sentinel starts with "dry:" -- we use null for the actual DB field
        attendingId = resolvedId.startsWith("dry:") ? null : resolvedId;
      } else {
        if (!report.unresolvedAttendings.includes(firstLink)) {
          report.unresolvedAttendings.push(firstLink);
        }
        // attendingId stays null
      }
    }

    const directorName = typeof f[CLINIC_FIELD.director] === "string"
      ? (f[CLINIC_FIELD.director] as string).trim() || null
      : null;
    const proceduresBooked = numberOrNull(f, CLINIC_FIELD.procedures);

    // Upsert on (termId, clinicDate)
    const existing = await prisma.rhdClinic.findUnique({
      where: { termId_clinicDate: { termId: term.id, clinicDate } },
    });

    if (!existing) {
      report.clinics.created++;
      if (!options.dryRun) {
        await prisma.rhdClinic.create({
          data: {
            termId: term.id,
            clinicDate,
            attendingId,
            directorName,
            proceduresBooked,
          },
        });
      }
    } else {
      const changed =
        existing.attendingId !== attendingId ||
        existing.directorName !== directorName ||
        existing.proceduresBooked !== proceduresBooked;

      if (changed) {
        report.clinics.updated++;
        if (!options.dryRun) {
          await prisma.rhdClinic.update({
            where: { id: existing.id },
            data: { attendingId, directorName, proceduresBooked },
          });
        }
      } else {
        report.clinics.unchanged++;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Audit (apply mode only)
  // -------------------------------------------------------------------------

  if (!options.dryRun) {
    await recordAudit({
      actorPersonId: null,
      action: "schedule.rhd_import",
      entityType: "RhdClinic",
      entityId: null,
      after: report as unknown as Prisma.InputJsonValue,
    });
  }

  return report;
}
