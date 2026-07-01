/**
 * Capacity metrics for scheduled clinics.
 *
 * Ported from the legacy HAVEN scheduler on 2026-06-07.
 * Source: src/app/components/schedule/capacity.ts
 *
 * Changes from legacy:
 * - rolesForDept parameter renamed from deptName to deptCode for clarity;
 *   behavior is identical (SCTP/JCTP are both codes and names in the legacy data).
 * - No em-dashes in comments.
 */

export type MedRole = "triage" | "walkin" | "cc";

export type DayCounts = {
  onShift: number;
  triage: number;
  walkin: number;
  cc: number;
  shadow: number;
  spanish: number;
  patientsBooked: number | null;
};

export type DayConfig = {
  idealHeadcount: number | null;
  patientCapacityPerProvider: number | null;
};

export type Quota = "missing" | "ok" | "excess";

export type DayMetrics = {
  headcount: number;
  idealHeadcount: number | null;
  headcountStatus: "under" | "at" | "over" | "unknown";
  triageStatus: Quota;
  walkinStatus: Quota;
  ccStatus: Quota;
  shadowCount: number;
  spanishCount: number;
  maxPatientCapacity: number | null;
  patientsBooked: number | null;
  patientsToReschedule: number | null;
};

export function quotaOf(n: number): Quota {
  return n === 0 ? "missing" : n === 1 ? "ok" : "excess";
}

export function computeDayMetrics(c: DayCounts, cfg: DayConfig): DayMetrics {
  const headcountStatus =
    cfg.idealHeadcount == null
      ? "unknown"
      : c.onShift < cfg.idealHeadcount
        ? "under"
        : c.onShift === cfg.idealHeadcount
          ? "at"
          : "over";
  const maxPatientCapacity =
    cfg.patientCapacityPerProvider == null ? null : cfg.patientCapacityPerProvider * c.onShift;
  const patientsToReschedule =
    c.patientsBooked != null && maxPatientCapacity != null
      ? Math.max(0, c.patientsBooked - maxPatientCapacity)
      : null;

  return {
    headcount: c.onShift,
    idealHeadcount: cfg.idealHeadcount,
    headcountStatus,
    triageStatus: quotaOf(c.triage),
    walkinStatus: quotaOf(c.walkin),
    ccStatus: quotaOf(c.cc),
    shadowCount: c.shadow,
    spanishCount: c.spanish,
    maxPatientCapacity,
    patientsBooked: c.patientsBooked,
    patientsToReschedule,
  };
}

/** Which special medical roles a department uses. Empty for non-PCAR departments.
 *  @param deptCode - the department code, e.g. "SCTP" or "JCTP". */
export function rolesForDept(deptCode: string): MedRole[] {
  if (deptCode === "SCTP") return ["triage", "walkin"];
  if (deptCode === "JCTP") return ["cc"];
  return [];
}
