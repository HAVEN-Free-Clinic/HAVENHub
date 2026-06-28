/**
 * Imports department capacity config (idealHeadcount, patientCapacityPerProvider)
 * from Airtable.
 *
 * Source:
 *   - SU 26 Roster table: Department Name (code), Ideal Headcount, Patient
 *     Capacity Per Provider number fields.
 *
 * AirtableClient.listAll requests returnFieldsByFieldId=true, so record fields
 * are keyed by FIELD ID (e.g. "fldBIGmgM2dU0vFUQ"), not display name. The
 * FIELD constants below map semantic names to those real field IDs.
 *
 * The import NEVER deletes rows; it only updates existing Department rows.
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
  rosterTableId: string;
  dryRun: boolean;
};

export type ScheduleConfigImportReport = {
  rosterRowsScanned: number;
  deptConfigChanged: number;
  unknownDepartments: string[];
};

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
 * In apply mode, updates Department config columns, then writes one AuditLog
 * entry. In dry-run mode, computes the same counts without any DB writes.
 */
export async function runScheduleConfigImport(
  reader: AirtableReader,
  options: ScheduleConfigImportOptions
): Promise<ScheduleConfigImportReport> {
  const report: ScheduleConfigImportReport = {
    rosterRowsScanned: 0,
    deptConfigChanged: 0,
    unknownDepartments: [],
  };

  // --- Departments: load all rows upfront into a map keyed by lower code ---
  const allDepts = await prisma.department.findMany({
    select: { id: true, code: true, idealHeadcount: true, patientCapacityPerProvider: true },
  });
  const deptByCodeLower = new Map<string, typeof allDepts[number]>();
  for (const d of allDepts) {
    deptByCodeLower.set(d.code.toLowerCase(), d);
  }

  // -------------------------------------------------------------------------
  // Department config
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
