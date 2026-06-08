/**
 * Tests for capacity engine - day metrics and department role mapping.
 *
 * Ported from legacy HAVEN scheduler on 2026-06-07.
 * Source: src/tests/capacity.test.ts (verbatim semantics)
 */

import { describe, it, expect } from "vitest";
import { computeDayMetrics, rolesForDept } from "./capacity";

describe("computeDayMetrics", () => {
  const base = { onShift: 10, triage: 1, walkin: 1, shadow: 2, spanish: 3, patientsBooked: null };

  it("flags headcount under/at/over against ideal", () => {
    expect(computeDayMetrics(base, { idealHeadcount: 11, patientCapacityPerProvider: 3 }).headcountStatus).toBe("under");
    expect(computeDayMetrics({ ...base, onShift: 11 }, { idealHeadcount: 11, patientCapacityPerProvider: 3 }).headcountStatus).toBe("at");
    expect(computeDayMetrics({ ...base, onShift: 12 }, { idealHeadcount: 11, patientCapacityPerProvider: 3 }).headcountStatus).toBe("over");
    expect(computeDayMetrics(base, { idealHeadcount: null, patientCapacityPerProvider: null }).headcountStatus).toBe("unknown");
  });

  it("flags triage/walk-in coverage", () => {
    const m = computeDayMetrics({ ...base, triage: 0, walkin: 2 }, { idealHeadcount: 11, patientCapacityPerProvider: 3 });
    expect(m.triageStatus).toBe("missing");
    expect(m.walkinStatus).toBe("excess");
  });

  it("computes capacity and reschedule pressure", () => {
    const m = computeDayMetrics({ ...base, onShift: 10, patientsBooked: 35 }, { idealHeadcount: 11, patientCapacityPerProvider: 3 });
    expect(m.maxPatientCapacity).toBe(30);
    expect(m.patientsToReschedule).toBe(5);
  });

  it("returns null capacity when no multiplier", () => {
    const m = computeDayMetrics({ ...base, patientsBooked: 5 }, { idealHeadcount: 11, patientCapacityPerProvider: null });
    expect(m.maxPatientCapacity).toBeNull();
    expect(m.patientsToReschedule).toBeNull();
  });
});

describe("rolesForDept", () => {
  it("maps PCAR departments to their roles by department code", () => {
    expect(rolesForDept("SCTP")).toEqual(["triage", "walkin"]);
    expect(rolesForDept("JCTP")).toEqual(["cc"]);
    expect(rolesForDept("EXEC")).toEqual([]);
  });
});
