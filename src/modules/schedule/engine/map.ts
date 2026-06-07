/**
 * Bridge from database rows to schedule engine shapes.
 *
 * Pure module: no Prisma imports, no platform imports.
 */

import type { ScheduleEntry } from "./conflicts";

export type AssignmentRow = {
  departmentId: string;
  departmentName: string;
  personId: string;
  clinicDate: Date;
  role: "DIRECTOR" | "VOLUNTEER" | "SHADOW";
};

/** Returns a UTC YYYY-MM-DD key for a date. */
export function isoDateKey(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Groups assignment rows into engine ScheduleEntry[] by (dateKey, departmentId),
 * splits ids by role, sorted by date then departmentName.
 */
export function toScheduleEntries(rows: AssignmentRow[]): ScheduleEntry[] {
  // Key: "dateKey|departmentId"
  const map = new Map<string, {
    date: string;
    departmentId: string;
    departmentName: string;
    directorIds: string[];
    volunteerIds: string[];
    shadowIds: string[];
  }>();

  // Callers pass deduplicated rows (the ShiftAssignment unique constraint
  // guarantees this upstream); duplicate ids would be emitted as-is.
  for (const row of rows) {
    const date = isoDateKey(row.clinicDate);
    // Key: "dateKey|departmentId". Safe: cuid ids are [a-z0-9] only, no pipes.
    const key = `${date}|${row.departmentId}`;
    if (!map.has(key)) {
      map.set(key, {
        date,
        departmentId: row.departmentId,
        departmentName: row.departmentName,
        directorIds: [],
        volunteerIds: [],
        shadowIds: [],
      });
    }
    const entry = map.get(key)!;
    if (row.role === "DIRECTOR") {
      entry.directorIds.push(row.personId);
    } else if (row.role === "VOLUNTEER") {
      entry.volunteerIds.push(row.personId);
    } else {
      entry.shadowIds.push(row.personId);
    }
  }

  return [...map.values()]
    .map(({ shadowIds, ...rest }): ScheduleEntry => ({
      ...rest,
      ...(shadowIds.length > 0 ? { shadowIds } : {}),
    }))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.departmentName.localeCompare(b.departmentName),
    );
}
