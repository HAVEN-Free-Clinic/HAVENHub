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
  /**
   * Make the Hub MATCH Airtable rather than merely absorb it: delete assignments
   * Airtable no longer lists, not just add the ones it does.
   *
   * Off by default, because the plain import is upsert-only on purpose. That is
   * also why it cannot be used to re-sync: a shift dropped in Airtable keeps its
   * Hub row forever, and a swap adds the new assignment while leaving the old
   * one behind, so both people show on both dates. Reconcile exists for the
   * one-off "Airtable is right, make the Hub agree" cutover.
   *
   * Deletion is scoped to the (department, clinic date) pairs Airtable actually
   * describes. A department or date absent from the export is left completely
   * alone rather than emptied -- a partial export must never read as "everyone
   * was unscheduled".
   */
  reconcile?: boolean;
  /**
   * Protect Hub-side changes at or after this instant from being reverted.
   *
   * Two separate sources, because they fail differently:
   *
   *   - ShiftAssignment.updatedAt covers a director editing the builder directly.
   *   - ShiftRequest.decidedAt covers approved swaps and drops. This one is
   *     load-bearing: approving a drop DELETES the assignment row (requests.ts
   *     deleteMany), so there is no row left carrying an updatedAt. Without the
   *     request-derived keys, a reconcile would cheerfully re-create every shift
   *     someone was released from today.
   *
   * Both sides of a swap, on both dates, are protected -- the safe superset.
   */
  protectSince?: Date;
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
  /** Reconcile mode: assignments deleted because Airtable no longer lists them. */
  removed: number;
  /**
   * Every removal, spelled out. A count alone is not reviewable before a
   * destructive apply against production, and this is the list a director reads
   * to confirm the diff is the one they expect.
   */
  removedDetail: Array<{ date: string; department: string; personId: string; role: string }>;
  /** Hub-side changes left untouched because they landed at or after protectSince. */
  protectedSkipped: Array<{ date: string; department: string; personId: string; reason: "recent-edit" | "recent-request" }>;
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
    removed: 0,
    removedDetail: [],
    protectedSkipped: [],
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

  // --- Hub-side changes the reconcile must not undo ---
  //
  // Keyed "<departmentId>|<dateKey>|<personId>". A protected key is skipped for
  // BOTH directions: Airtable can neither add it back nor take it away. That is
  // the point -- the Hub is the newer authority for anything touched since the
  // cutoff, whichever way it was touched.
  const protectedKeys = new Map<string, "recent-edit" | "recent-request">();
  const protectKey = (
    departmentId: string,
    date: Date | null,
    personId: string | null,
    reason: "recent-edit" | "recent-request",
  ) => {
    if (!date || !personId) return;
    protectedKeys.set(`${departmentId}|${isoDateKey(date)}|${personId}`, reason);
  };

  if (options.reconcile && options.protectSince) {
    const since = options.protectSince;

    // 1. Rows created or edited in the builder. Prisma stamps updatedAt on create
    //    too, so this covers a brand-new assignment as well as a role/tag change.
    const recentlyTouched = await prisma.shiftAssignment.findMany({
      where: { termId: term.id, updatedAt: { gte: since } },
      select: { departmentId: true, clinicDate: true, personId: true },
    });
    for (const row of recentlyTouched) {
      protectKey(row.departmentId, row.clinicDate, row.personId, "recent-edit");
    }

    // 2. Approved swaps and drops. Load-bearing: approving a drop DELETES the
    //    assignment, so nothing above can see it. Both people and both dates are
    //    protected -- a swap moves two people across two dates, and protecting
    //    the superset is the safe direction when the alternative is resurrecting
    //    a shift somebody was released from.
    const recentDecisions = await prisma.shiftRequest.findMany({
      where: { termId: term.id, status: "APPROVED", decidedAt: { gte: since } },
      select: {
        departmentId: true, requesterId: true, requesterDate: true,
        targetId: true, targetDate: true,
      },
    });
    for (const r of recentDecisions) {
      for (const date of [r.requesterDate, r.targetDate]) {
        protectKey(r.departmentId, date, r.requesterId, "recent-request");
        protectKey(r.departmentId, date, r.targetId, "recent-request");
      }
    }

    // 3. Direct builder removals. schedule.unassign deletes the row outright, so
    //    like an approved drop it leaves nothing behind carrying a timestamp --
    //    the audit entry is the only evidence it happened. entityId is written as
    //    "<termId>|<departmentId>|<dateKey>|<personId>" (builder.ts).
    const recentAudits = await prisma.auditLog.findMany({
      where: {
        entityType: "ShiftAssignment",
        action: { in: ["schedule.unassign", "schedule.assign"] },
        createdAt: { gte: since },
      },
      select: { entityId: true },
    });
    for (const { entityId } of recentAudits) {
      const parts = (entityId ?? "").split("|");
      if (parts.length !== 4 || parts[0] !== term.id) continue;
      const [, departmentId, dateKey, personId] = parts;
      protectedKeys.set(`${departmentId}|${dateKey}|${personId}`, "recent-edit");
    }
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

    const departmentCode = allDepartments.find((d) => d.id === departmentId)?.code ?? departmentId;
    const isProtected = (personId: string) => protectedKeys.get(`${departmentId}|${dateStr}|${personId}`);

    // Apply: upsert each desired row
    for (const desired of desiredMap.values()) {
      const guard = isProtected(desired.personId);
      if (guard) {
        report.protectedSkipped.push({ date: dateStr, department: departmentCode, personId: desired.personId, reason: guard });
        continue;
      }
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

    // Reconcile: anyone the Hub has for this (department, date) that Airtable no
    // longer lists. Scoped to this pair precisely because Airtable described it;
    // a department or date missing from the export never reaches here, so a
    // partial export cannot empty the schedule.
    if (options.reconcile) {
      for (const [personId, row] of existingMap) {
        if (desiredMap.has(personId)) continue;
        const guard = isProtected(personId);
        if (guard) {
          report.protectedSkipped.push({ date: dateStr, department: departmentCode, personId, reason: guard });
          continue;
        }
        report.removedDetail.push({ date: dateStr, department: departmentCode, personId, role: row.role });
        report.removed++;
        if (!options.dryRun) {
          await prisma.shiftAssignment.delete({ where: { id: row.id } });
        }
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
