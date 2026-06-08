/**
 * Tests for requests engine - schedule request validation and mutation planning.
 *
 * Ported from legacy HAVEN scheduler on 2026-06-07.
 * validate cases: server/tests/requests.validate.test.ts (verbatim semantics)
 * apply cases: server/tests/requests.apply.test.ts (adapted to AssignmentMutation shape)
 */

import { describe, it, expect } from "vitest";
import {
  validateRequest,
  planApply,
  type ScheduleRowForValidation,
  type AssignmentMutation,
} from "./requests";

// ---------------------------------------------------------------------------
// validateRequest
// ---------------------------------------------------------------------------

const rows: ScheduleRowForValidation[] = [
  { date: "2026-05-30", directorIds: ["dA"], volunteerIds: ["vA", "vB"] },
  { date: "2026-06-06", directorIds: ["dB"], volunteerIds: ["vA"] },
];

describe("validateRequest", () => {
  it("accepts a drop where the requester is assigned to that date", () => {
    expect(
      validateRequest({
        scheduleRows: rows,
        requesterId: "vA",
        requesterDate: "2026-05-30",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a drop where the requester is not on that date", () => {
    expect(
      validateRequest({
        scheduleRows: rows,
        requesterId: "vC",
        requesterDate: "2026-05-30",
      }),
    ).toEqual({ ok: false, error: "Not assigned to that shift" });
  });

  it("rejects a self-target (requester == target)", () => {
    expect(
      validateRequest({
        scheduleRows: rows,
        requesterId: "vA",
        requesterDate: "2026-05-30",
        targetId: "vA",
        targetDate: "2026-06-06",
      }),
    ).toEqual({ ok: false, error: "Partner is not eligible" });
  });

  it("accepts a named swap between two different volunteers", () => {
    const r: ScheduleRowForValidation[] = [
      { date: "2026-05-30", directorIds: [], volunteerIds: ["vA"] },
      { date: "2026-06-06", directorIds: [], volunteerIds: ["vB"] },
    ];
    expect(
      validateRequest({
        scheduleRows: r,
        requesterId: "vA",
        requesterDate: "2026-05-30",
        targetId: "vB",
        targetDate: "2026-06-06",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a named swap where the target is not on the target date", () => {
    expect(
      validateRequest({
        scheduleRows: rows,
        requesterId: "vA",
        requesterDate: "2026-05-30",
        targetId: "vB",
        targetDate: "2026-06-06",
      }),
    ).toEqual({ ok: false, error: "Partner is not eligible" });
  });

  it("rejects a named swap with mismatched roles (volunteer requester, director target)", () => {
    expect(
      validateRequest({
        scheduleRows: rows,
        requesterId: "vA",
        requesterDate: "2026-05-30",
        targetId: "dB",
        targetDate: "2026-06-06",
      }),
    ).toEqual({ ok: false, error: "Partner is not eligible" });
  });

  it("rejects when targetId is provided without targetDate", () => {
    expect(
      validateRequest({
        scheduleRows: rows,
        requesterId: "vA",
        requesterDate: "2026-05-30",
        targetId: "vB",
      }),
    ).toEqual({ ok: false, error: "Partner is not eligible" });
  });

  it("treats request as a drop when targetId and targetDate are both omitted", () => {
    expect(
      validateRequest({
        scheduleRows: rows,
        requesterId: "vA",
        requesterDate: "2026-05-30",
      }),
    ).toEqual({ ok: true });
  });

  describe("shadow shifts", () => {
    const shadowRows: ScheduleRowForValidation[] = [
      { date: "2026-05-30", directorIds: ["dA"], volunteerIds: ["vA"], shadowIds: ["sA"] },
      { date: "2026-06-06", directorIds: [], volunteerIds: ["vB"], shadowIds: ["sB"] },
    ];

    it("accepts a shadow drop (no target)", () => {
      expect(
        validateRequest({
          scheduleRows: shadowRows,
          requesterId: "sA",
          requesterDate: "2026-05-30",
        }),
      ).toEqual({ ok: true });
    });

    it("rejects a shadow named-swap with a clear message", () => {
      expect(
        validateRequest({
          scheduleRows: shadowRows,
          requesterId: "sA",
          requesterDate: "2026-05-30",
          targetId: "sB",
          targetDate: "2026-06-06",
        }),
      ).toEqual({ ok: false, error: "Shadow shifts can only be dropped, not swapped" });
    });

    it("rejects a regular volunteer trying to name a shadow as the swap target", () => {
      expect(
        validateRequest({
          scheduleRows: shadowRows,
          requesterId: "vA",
          requesterDate: "2026-05-30",
          targetId: "sB",
          targetDate: "2026-06-06",
        }),
      ).toEqual({ ok: false, error: "Partner is not eligible" });
    });
  });
});

// ---------------------------------------------------------------------------
// planApply - adapted to AssignmentMutation shape
// ---------------------------------------------------------------------------

const baseRows: ScheduleRowForValidation[] = [
  { date: "2026-05-30", directorIds: ["dA"], volunteerIds: ["vA", "vB"] },
  { date: "2026-06-06", directorIds: ["dA"], volunteerIds: ["vC"] },
];

describe("planApply", () => {
  it("for a drop, emits a single remove mutation for the requester", () => {
    const mutations = planApply({
      scheduleRows: baseRows,
      requesterId: "vA",
      requesterDate: "2026-05-30",
    });
    expect(mutations).toEqual<AssignmentMutation[]>([
      { op: "remove", personId: "vA", dateKey: "2026-05-30", role: "volunteer" },
    ]);
  });

  it("for a named swap, emits four mutations in deterministic order", () => {
    const mutations = planApply({
      scheduleRows: baseRows,
      requesterId: "vA",
      requesterDate: "2026-05-30",
      targetId: "vC",
      targetDate: "2026-06-06",
    });
    expect(mutations).toEqual<AssignmentMutation[]>([
      { op: "remove", personId: "vA", dateKey: "2026-05-30", role: "volunteer" },
      { op: "add",    personId: "vC", dateKey: "2026-05-30", role: "volunteer" },
      { op: "remove", personId: "vC", dateKey: "2026-06-06", role: "volunteer" },
      { op: "add",    personId: "vA", dateKey: "2026-06-06", role: "volunteer" },
    ]);
  });

  it("for a director-director swap, emits mutations with role director", () => {
    const rows: ScheduleRowForValidation[] = [
      { date: "2026-05-30", directorIds: ["dA", "dB"], volunteerIds: [] },
      { date: "2026-06-06", directorIds: ["dC"], volunteerIds: [] },
    ];
    const mutations = planApply({
      scheduleRows: rows,
      requesterId: "dA",
      requesterDate: "2026-05-30",
      targetId: "dC",
      targetDate: "2026-06-06",
    });
    expect(mutations).toEqual<AssignmentMutation[]>([
      { op: "remove", personId: "dA", dateKey: "2026-05-30", role: "director" },
      { op: "add",    personId: "dC", dateKey: "2026-05-30", role: "director" },
      { op: "remove", personId: "dC", dateKey: "2026-06-06", role: "director" },
      { op: "add",    personId: "dA", dateKey: "2026-06-06", role: "director" },
    ]);
  });

  it("throws if the requester's row is missing", () => {
    expect(() =>
      planApply({
        scheduleRows: baseRows,
        requesterId: "vZ",
        requesterDate: "2026-05-30",
      }),
    ).toThrow(/not assigned/i);
  });

  it("for a shadow drop, emits a remove mutation with role shadow", () => {
    const rows: ScheduleRowForValidation[] = [
      { date: "2026-05-30", directorIds: [], volunteerIds: ["vA"], shadowIds: ["sA", "sB"] },
    ];
    const mutations = planApply({
      scheduleRows: rows,
      requesterId: "sA",
      requesterDate: "2026-05-30",
    });
    expect(mutations).toEqual<AssignmentMutation[]>([
      { op: "remove", personId: "sA", dateKey: "2026-05-30", role: "shadow" },
    ]);
  });

  it("throws if a shadow named-swap somehow reaches planApply", () => {
    const rows: ScheduleRowForValidation[] = [
      { date: "2026-05-30", directorIds: [], volunteerIds: [], shadowIds: ["sA"] },
      { date: "2026-06-06", directorIds: [], volunteerIds: [], shadowIds: ["sB"] },
    ];
    expect(() =>
      planApply({
        scheduleRows: rows,
        requesterId: "sA",
        requesterDate: "2026-05-30",
        targetId: "sB",
        targetDate: "2026-06-06",
      }),
    ).toThrow(/shadow/i);
  });
});
