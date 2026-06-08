/**
 * Imports the SU 26 Schedule table from Airtable into ShiftAssignment rows.
 *
 * AirtableClient.listAll requests returnFieldsByFieldId=true, so record fields
 * are keyed by FIELD ID (e.g. "fldRqPKWn6NxzoJXZ"), not display name. The FIELD
 * constants below map semantic names to those real field IDs.
 *
 * Fields used:
 *   fldBdcAE6F8Bqu4FW  "Department Name (from Department)" - lookup array;
 *     first element is the department CODE (e.g. "EDUC"), matched
 *     case-insensitively against Department.code.
 *   fldRqPKWn6NxzoJXZ  "Date" - ISO date string "YYYY-MM-DD".
 *   fldWECXlelGfP9Sb0  "Directors on Shift"
 *   fldMoCbSA44uhyjxx  "Volunteers on Shift"
 *   fldqFDr9lu1Ih4YC0  "Shadow Volunteers on Shift"
 *   fldvZalLmfRQijopm  "Remote on Shift"
 *   fldmQasTpGxocBz9l  "Triage on Shift"
 *   fldepAQbnkNquxSYd  "Walk-in on Shift"
 *   fldxyf4junebaIIYQ  "CC on Shift"
 *   All person-link fields contain All People airtable record ids.
 *
 * The import NEVER deletes existing ShiftAssignment rows; it only upserts.
 *
 * WARNING: this is a one-time SU 26 cutover import. Re-running in apply mode
 * after the Part 2 builder has made manual edits WILL overwrite those edits
 * (role and tag fields are updated to match Airtable). Review the dry-run
 * "updated" count first; do not re-apply after the builder is live unless a
 * full Airtable resync is intended.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { isoDateKey } from "@/platform/dates";
import type { AirtableReader } from "./importer";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ScheduleImportOptions = {
  baseId: string;
  scheduleTableId: string;
  termCode: string;
  dryRun: boolean;
};

export type ScheduleImportReport = {
  rows: number;
  created: number;
  updated: number;
  unchanged: number;
  unresolvedPeople: Array<{ rowId: string; recordId: string }>;
  /** Department codes found in the lookup field that could not be matched to a DB Department. */
  unknownDepartments: string[];
  skippedDates: string[];
  /** Desired assignment counts per clinic date (ISO day key), for dry-run review. */
  perDateCounts: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Schedule field IDs (returnFieldsByFieldId=true; display names in comments).
// ---------------------------------------------------------------------------

const FIELD = {
  departmentLookup: "fldBdcAE6F8Bqu4FW", // Department Name (from Department) - value is department CODE
  date: "fldRqPKWn6NxzoJXZ",             // Date
  directors: "fldWECXlelGfP9Sb0",         // Directors on Shift
  volunteers: "fldMoCbSA44uhyjxx",         // Volunteers on Shift
  shadows: "fldqFDr9lu1Ih4YC0",           // Shadow Volunteers on Shift
  remote: "fldvZalLmfRQijopm",            // Remote on Shift
  triage: "fldmQasTpGxocBz9l",            // Triage on Shift
  walkin: "fldepAQbnkNquxSYd",            // Walk-in on Shift
  cc: "fldxyf4junebaIIYQ",               // CC on Shift
} as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract a string array from a field value (link or lookup arrays). */
function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** Extract the first non-empty string from a lookup array. */
function firstStr(value: unknown): string | null {
  const arr = strArray(value);
  for (const s of arr) {
    const t = s.trim();
    if (t.length) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Runs the SU 26 Schedule import.
 *
 * In apply mode, upserts ShiftAssignment rows and writes one AuditLog entry.
 * In dry-run mode, computes the same counts without any DB writes.
 */
export async function runScheduleImport(
  reader: AirtableReader,
  options: ScheduleImportOptions
): Promise<ScheduleImportReport> {
  const report: ScheduleImportReport = {
    rows: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    unresolvedPeople: [],
    unknownDepartments: [],
    skippedDates: [],
    perDateCounts: {},
  };

  // --- Load term ---
  const term = await prisma.term.findUnique({ where: { code: options.termCode } });
  if (!term) {
    throw new Error(
      `Term with code "${options.termCode}" not found. Run the people/roster import first.`
    );
  }

  // Build a map of ISO day key -> clinic date (DateTime)
  const clinicDateMap = new Map<string, Date>();
  for (const d of term.clinicDates) {
    clinicDateMap.set(isoDateKey(d), d);
  }

  // --- Load departments (code -> id, case-insensitive) ---
  const allDepartments = await prisma.department.findMany();
  const deptByCodeLower = new Map<string, string>(); // lower code -> dept id
  for (const dept of allDepartments) {
    deptByCodeLower.set(dept.code.toLowerCase(), dept.id);
  }

  // --- Load schedule rows from Airtable ---
  const scheduleRecords = await reader.listAll(options.baseId, options.scheduleTableId);

  // Collect all linked person record ids for a single bulk DB lookup
  const allPersonRecordIds = new Set<string>();
  for (const record of scheduleRecords) {
    const f = record.fields;
    for (const field of [
      FIELD.directors,
      FIELD.volunteers,
      FIELD.shadows,
      FIELD.remote,
      FIELD.triage,
      FIELD.walkin,
      FIELD.cc,
    ]) {
      for (const id of strArray(f[field])) {
        allPersonRecordIds.add(id);
      }
    }
  }

  // One query to resolve all airtableRecordIds to DB person ids
  const personRows = await prisma.person.findMany({
    where: { airtableRecordId: { in: [...allPersonRecordIds] } },
    select: { id: true, airtableRecordId: true },
  });
  const personIdByRecordId = new Map<string, string>();
  for (const p of personRows) {
    if (p.airtableRecordId) {
      personIdByRecordId.set(p.airtableRecordId, p.id);
    }
  }

  // --- Process each row ---
  for (const record of scheduleRecords) {
    report.rows++;
    const f = record.fields;
    const rowId = record.id;

    // Resolve date
    const dateStr = typeof f[FIELD.date] === "string" ? (f[FIELD.date] as string).trim() : null;
    if (!dateStr || !clinicDateMap.has(dateStr)) {
      if (dateStr && !report.skippedDates.includes(dateStr)) {
        report.skippedDates.push(dateStr);
      }
      continue;
    }
    const clinicDate = clinicDateMap.get(dateStr)!;

    // Resolve department: lookup value contains the department CODE (e.g. "EDUC")
    const rawDeptCode = firstStr(f[FIELD.departmentLookup]);
    if (!rawDeptCode) {
      // No department code at all; skip silently (not an unknown dept -- just empty)
      continue;
    }
    const departmentId = deptByCodeLower.get(rawDeptCode.toLowerCase());
    if (!departmentId) {
      if (!report.unknownDepartments.includes(rawDeptCode)) {
        report.unknownDepartments.push(rawDeptCode);
      }
      continue;
    }

    // --- Build desired assignments for this row ---
    // Each entry: { personId, role, triage, walkin, cc, remote }
    type DesiredAssignment = {
      personId: string;
      role: "DIRECTOR" | "VOLUNTEER" | "SHADOW";
      triage: boolean;
      walkin: boolean;
      cc: boolean;
      remote: boolean;
    };

    // Helper: resolve ids, log unresolved
    const resolve = (recordIds: string[]): string[] => {
      const resolved: string[] = [];
      for (const rid of recordIds) {
        const pid = personIdByRecordId.get(rid);
        if (pid) {
          resolved.push(pid);
        } else {
          report.unresolvedPeople.push({ rowId, recordId: rid });
        }
      }
      return resolved;
    };

    const directorIds = resolve(strArray(f[FIELD.directors]));
    const volunteerIds = resolve(strArray(f[FIELD.volunteers]));
    const shadowIds = resolve(strArray(f[FIELD.shadows]));
    const triageIds = resolve(strArray(f[FIELD.triage]));
    const walkinIds = resolve(strArray(f[FIELD.walkin]));
    const ccIds = resolve(strArray(f[FIELD.cc]));
    const remoteIds = resolve(strArray(f[FIELD.remote]));

    // Build desired map: personId -> DesiredAssignment
    // Rule: if a person is in both directors and volunteers, keep DIRECTOR only
    //       (the unique key is per person per dept/date; pick DIRECTOR and count it once).
    const desiredMap = new Map<string, DesiredAssignment>();

    for (const pid of directorIds) {
      desiredMap.set(pid, { personId: pid, role: "DIRECTOR", triage: false, walkin: false, cc: false, remote: false });
    }

    for (const pid of shadowIds) {
      if (!desiredMap.has(pid)) {
        desiredMap.set(pid, { personId: pid, role: "SHADOW", triage: false, walkin: false, cc: false, remote: false });
      }
    }

    for (const pid of volunteerIds) {
      if (!desiredMap.has(pid)) {
        desiredMap.set(pid, { personId: pid, role: "VOLUNTEER", triage: false, walkin: false, cc: false, remote: false });
      }
      // If already a DIRECTOR, skip (director takes precedence)
    }

    // Tag lists: triage/walkin/cc/remote set booleans on the existing assignment.
    // "Tag implies on-shift" invariant: a tagged person not already assigned in
    // this row gets a new VOLUNTEER row so the tag is never silently dropped.
    // If the person is already assigned as a DIRECTOR or SHADOW, the tag boolean
    // is set on that existing row (no duplicate row is created).
    const tagSets: Array<{ ids: string[]; flag: "triage" | "walkin" | "cc" | "remote" }> = [
      { ids: triageIds, flag: "triage" },
      { ids: walkinIds, flag: "walkin" },
      { ids: ccIds, flag: "cc" },
      { ids: remoteIds, flag: "remote" },
    ];

    for (const { ids, flag } of tagSets) {
      for (const pid of ids) {
        const existing = desiredMap.get(pid);
        if (!existing) {
          // Tag-implies-on-shift: create a VOLUNTEER row for this person
          desiredMap.set(pid, { personId: pid, role: "VOLUNTEER", triage: false, walkin: false, cc: false, remote: false });
        }
        const entry = desiredMap.get(pid)!;
        // Tag-implies-on-shift creates a VOLUNTEER row only when the person has
        // no existing entry. If they are already a DIRECTOR or SHADOW, the flag
        // is set on that row instead so tag data is never silently dropped (the
        // schema has no role restriction on the tag columns).
        entry[flag] = true;
      }
    }

    if (desiredMap.size === 0) continue;

    report.perDateCounts[dateStr] = (report.perDateCounts[dateStr] ?? 0) + desiredMap.size;

    // --- Diff against existing rows ---
    const existing = await prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId, clinicDate },
    });
    const existingMap = new Map<string, typeof existing[number]>();
    for (const row of existing) {
      existingMap.set(row.personId, row);
    }

    // Apply: upsert each desired row
    for (const desired of desiredMap.values()) {
      const existingRow = existingMap.get(desired.personId);

      if (existingRow) {
        // Check if anything changed
        const changed =
          existingRow.role !== desired.role ||
          existingRow.triage !== desired.triage ||
          existingRow.walkin !== desired.walkin ||
          existingRow.cc !== desired.cc ||
          existingRow.remote !== desired.remote;

        if (!changed) {
          report.unchanged++;
          continue;
        }

        // Dry run: count update but do not write
        if (options.dryRun) {
          report.updated++;
          continue;
        }

        await prisma.shiftAssignment.update({
          where: { id: existingRow.id },
          data: {
            role: desired.role,
            triage: desired.triage,
            walkin: desired.walkin,
            cc: desired.cc,
            remote: desired.remote,
          },
        });
        report.updated++;
      } else {
        // Dry run: count create but do not write
        if (options.dryRun) {
          report.created++;
          continue;
        }

        await prisma.shiftAssignment.create({
          data: {
            termId: term.id,
            departmentId,
            personId: desired.personId,
            clinicDate,
            role: desired.role,
            triage: desired.triage,
            walkin: desired.walkin,
            cc: desired.cc,
            remote: desired.remote,
          },
        });
        report.created++;
      }
    }
  }

  // One audit entry in apply mode
  if (!options.dryRun) {
    await recordAudit({
      actorPersonId: null,
      action: "schedule.import",
      entityType: "ShiftAssignment",
      entityId: null,
      after: report as unknown as Prisma.InputJsonValue,
    });
  }

  return report;
}
