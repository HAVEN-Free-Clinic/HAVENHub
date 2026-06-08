/**
 * Imports person-level flags (spanishSpeaking, licensedRN) and department
 * capacity config (idealHeadcount, patientCapacityPerProvider) from Airtable.
 *
 * Sources:
 *   - All People table: Spanish Speaking and Licensed RN checkbox fields.
 *   - SU 26 Roster table: Department Name (code), Ideal Headcount, Patient
 *     Capacity Per Provider number fields.
 *
 * AirtableClient.listAll requests returnFieldsByFieldId=true, so record fields
 * are keyed by FIELD ID (e.g. "fldU9oI3O8CaB17j1"), not display name. The
 * FIELD constants below map semantic names to those real field IDs.
 *
 * Checkbox fields: present as `true` when checked; ABSENT (not `false`) when
 * unchecked. Airtable is authoritative at cutover: a true platform flag CAN
 * be lowered to false.
 *
 * The import NEVER deletes rows; it only updates existing Person and
 * Department rows.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import type { AirtableReader } from "./importer";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ScheduleConfigImportOptions = {
  baseId: string;
  peopleTableId: string;
  rosterTableId: string;
  dryRun: boolean;
};

export type ScheduleConfigImportReport = {
  peopleScanned: number;
  /** Rows whose spanishSpeaking changed (either direction). */
  spanishChanged: number;
  rnChanged: number;
  /** Airtable rows with no matching Person.airtableRecordId. */
  peopleUnresolved: number;
  rosterRowsScanned: number;
  deptConfigChanged: number;
  unknownDepartments: string[];
};

// ---------------------------------------------------------------------------
// All People field IDs (returnFieldsByFieldId=true; display names in comments)
// ---------------------------------------------------------------------------

const PEOPLE_FIELD = {
  spanish: "fldU9oI3O8CaB17j1", // Spanish Speaking (checkbox)
  rn: "fld16LPmc7y1gQZ7K",       // Licensed RN (checkbox)
} as const;

// ---------------------------------------------------------------------------
// SU 26 Roster field IDs
// ---------------------------------------------------------------------------

const ROSTER_FIELD = {
  deptCode: "fldBIGmgM2dU0vFUQ", // Department Name (singleLineText: dept CODE)
  idealHeadcount: "fldKxrbiiBNty8aHq", // Ideal Headcount (number)
  patientCapacity: "fldYkBnHvszTKUHT0", // Patient Capacity Per Provider (number)
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read an Airtable checkbox field: present as `true` -> true, absent -> false. */
function checkboxValue(fields: Record<string, unknown>, fieldId: string): boolean {
  return fields[fieldId] === true;
}

/** Read a number field; absent or non-number -> null. */
function numberOrNull(fields: Record<string, unknown>, fieldId: string): number | null {
  const v = fields[fieldId];
  if (typeof v === "number" && isFinite(v)) return v;
  return null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Runs the schedule config import.
 *
 * In apply mode, updates Person flags and Department config columns, then
 * writes one AuditLog entry. In dry-run mode, computes the same counts
 * without any DB writes.
 */
export async function runScheduleConfigImport(
  reader: AirtableReader,
  options: ScheduleConfigImportOptions
): Promise<ScheduleConfigImportReport> {
  const report: ScheduleConfigImportReport = {
    peopleScanned: 0,
    spanishChanged: 0,
    rnChanged: 0,
    peopleUnresolved: 0,
    rosterRowsScanned: 0,
    deptConfigChanged: 0,
    unknownDepartments: [],
  };

  // --- People: load all rows upfront into a map keyed by airtableRecordId ---
  const allPersonRows = await prisma.person.findMany({
    select: { id: true, airtableRecordId: true, spanishSpeaking: true, licensedRN: true },
  });
  const personByRecordId = new Map<string, typeof allPersonRows[number]>();
  for (const p of allPersonRows) {
    if (p.airtableRecordId) {
      personByRecordId.set(p.airtableRecordId, p);
    }
  }

  // --- Departments: load all rows upfront into a map keyed by lower code ---
  const allDepts = await prisma.department.findMany({
    select: { id: true, code: true, idealHeadcount: true, patientCapacityPerProvider: true },
  });
  const deptByCodeLower = new Map<string, typeof allDepts[number]>();
  for (const d of allDepts) {
    deptByCodeLower.set(d.code.toLowerCase(), d);
  }

  // -------------------------------------------------------------------------
  // Phase 1: People flags
  // -------------------------------------------------------------------------

  const peopleRecords = await reader.listAll(options.baseId, options.peopleTableId);

  for (const record of peopleRecords) {
    report.peopleScanned++;
    const person = personByRecordId.get(record.id);
    if (!person) {
      report.peopleUnresolved++;
      continue;
    }

    const desiredSpanish = checkboxValue(record.fields, PEOPLE_FIELD.spanish);
    const desiredRn = checkboxValue(record.fields, PEOPLE_FIELD.rn);

    const spanishDiff = person.spanishSpeaking !== desiredSpanish;
    const rnDiff = person.licensedRN !== desiredRn;

    if (spanishDiff) report.spanishChanged++;
    if (rnDiff) report.rnChanged++;

    if ((spanishDiff || rnDiff) && !options.dryRun) {
      await prisma.person.update({
        where: { id: person.id },
        data: { spanishSpeaking: desiredSpanish, licensedRN: desiredRn },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: Department config
  // -------------------------------------------------------------------------

  const rosterRecords = await reader.listAll(options.baseId, options.rosterTableId);

  for (const record of rosterRecords) {
    report.rosterRowsScanned++;
    const f = record.fields;

    const rawCode = typeof f[ROSTER_FIELD.deptCode] === "string"
      ? (f[ROSTER_FIELD.deptCode] as string).trim()
      : null;

    if (!rawCode) continue;

    const dept = deptByCodeLower.get(rawCode.toLowerCase());
    if (!dept) {
      if (!report.unknownDepartments.includes(rawCode)) {
        report.unknownDepartments.push(rawCode);
      }
      continue;
    }

    const desiredHc = numberOrNull(f, ROSTER_FIELD.idealHeadcount);
    const desiredCap = numberOrNull(f, ROSTER_FIELD.patientCapacity);

    const hcDiff = dept.idealHeadcount !== desiredHc;
    const capDiff = dept.patientCapacityPerProvider !== desiredCap;

    if (hcDiff || capDiff) {
      report.deptConfigChanged++;
      if (!options.dryRun) {
        await prisma.department.update({
          where: { id: dept.id },
          data: {
            idealHeadcount: desiredHc,
            patientCapacityPerProvider: desiredCap,
          },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Audit (apply mode only)
  // -------------------------------------------------------------------------

  if (!options.dryRun) {
    await recordAudit({
      actorPersonId: null,
      action: "schedule.config_import",
      entityType: "Person",
      entityId: null,
      after: report as unknown as Prisma.InputJsonValue,
    });
  }

  return report;
}
