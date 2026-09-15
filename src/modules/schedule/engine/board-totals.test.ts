import { describe, it, expect } from "vitest";
import { boardTotals, type CountableAssignment } from "./board-totals";

const NO_TAGS = { triage: false, walkin: false, cc: false };

function a(
  role: CountableAssignment["role"],
  tags: Partial<typeof NO_TAGS> = {},
): CountableAssignment {
  return { role, tags: { ...NO_TAGS, ...tags } };
}

const D1 = "2026-06-06";
const D2 = "2026-06-13";
const D3 = "2026-06-20";
const DATES = [D1, D2, D3];

describe("boardTotals: a person's own row", () => {
  it("counts every shift on the row, whatever role the person holds", () => {
    const totals = boardTotals({
      assignments: {
        [D1]: { p1: a("VOLUNTEER") },
        [D2]: { p1: a("SHADOW") },
        [D3]: { p1: a("DIRECTOR") },
      },
      dateKeys: DATES,
      countableIds: new Set(["p1"]),
    });

    expect(totals.perPerson.p1?.shifts).toBe(3);
  });

  it("ignores a shift on a date the term does not list", () => {
    const totals = boardTotals({
      assignments: {
        [D1]: { p1: a("VOLUNTEER") },
        "2025-01-04": { p1: a("VOLUNTEER") },
      },
      dateKeys: DATES,
      countableIds: new Set(["p1"]),
    });

    expect(totals.perPerson.p1?.shifts).toBe(1);
  });

  it("counts a med role only on the shifts carrying that tag", () => {
    const totals = boardTotals({
      assignments: {
        [D1]: { p1: a("VOLUNTEER", { triage: true }) },
        [D2]: { p1: a("VOLUNTEER", { triage: true }) },
        [D3]: { p1: a("VOLUNTEER") },
      },
      dateKeys: DATES,
      countableIds: new Set(["p1"]),
    });

    expect(totals.perPerson.p1).toMatchObject({ shifts: 3, triage: 2, walkin: 0, cc: 0 });
  });

  it("counts each med role independently when one shift carries two", () => {
    const totals = boardTotals({
      assignments: { [D1]: { p1: a("VOLUNTEER", { triage: true, cc: true }) } },
      dateKeys: DATES,
      countableIds: new Set(["p1"]),
    });

    expect(totals.perPerson.p1).toMatchObject({ shifts: 1, triage: 1, cc: 1 });
  });

  // A former member's leftover shifts are still theirs: the row total answers
  // "how many shifts does this person have", which stays true after offboarding.
  // Only the date total below treats them differently.
  it("counts a person's shifts even when they do not count toward a date", () => {
    const totals = boardTotals({
      assignments: { [D1]: { gone: a("VOLUNTEER") } },
      dateKeys: DATES,
      countableIds: new Set(),
    });

    expect(totals.perPerson.gone?.shifts).toBe(1);
  });
});

describe("boardTotals: volunteers on a date", () => {
  it("counts the volunteers, not the directors or the shadows", () => {
    const totals = boardTotals({
      assignments: {
        [D1]: { p1: a("VOLUNTEER"), p2: a("VOLUNTEER"), p3: a("DIRECTOR"), p4: a("SHADOW") },
      },
      dateKeys: DATES,
      countableIds: new Set(["p1", "p2", "p3", "p4"]),
    });

    expect(totals.volunteersByDate[D1]).toBe(2);
  });

  // Mirrors countableMemberIds in builderView: an offboarded person still
  // holding a shift is shown so it can be cleared, but is not coverage.
  it("leaves a former member out of the date's count", () => {
    const totals = boardTotals({
      assignments: { [D1]: { p1: a("VOLUNTEER"), gone: a("VOLUNTEER") } },
      dateKeys: DATES,
      countableIds: new Set(["p1"]),
    });

    expect(totals.volunteersByDate[D1]).toBe(1);
  });

  it("reports zero for a date nobody is on, rather than leaving it out", () => {
    const totals = boardTotals({
      assignments: { [D1]: { p1: a("VOLUNTEER") } },
      dateKeys: DATES,
      countableIds: new Set(["p1"]),
    });

    expect(totals.volunteersByDate[D2]).toBe(0);
    expect(totals.volunteersByDate[D3]).toBe(0);
  });
});

describe("boardTotals: an empty board", () => {
  it("reports every date as zero and nobody as assigned", () => {
    const totals = boardTotals({
      assignments: {},
      dateKeys: DATES,
      countableIds: new Set(["p1"]),
    });

    expect(totals.perPerson).toEqual({});
    expect(totals.volunteersByDate).toEqual({ [D1]: 0, [D2]: 0, [D3]: 0 });
  });
});
