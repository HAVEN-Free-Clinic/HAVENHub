import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BuilderGrid } from "./builder-grid";
import type { BuilderMember } from "@/modules/schedule/services/builder";

/** Noon-UTC anchored calendar date, matching how the schema stores clinicDate. */
function d(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

const member: BuilderMember = {
  membershipId: "mem-1",
  person: { id: "p1", name: "Alice Volunteer", verifiedLanguages: [], licensedRN: false },
  kind: "VOLUNTEER",
  availability: { tier: "SELF", dates: [] },
  overrideActive: false,
  acknowledgePending: false,
  legacyNote: null,
  intake: { minShiftsWanted: null, additionalShiftAvailability: null, feedback: null },
};

function renderGrid(clinicDates: Date[]) {
  return renderToStaticMarkup(
    <BuilderGrid
      members={[member]}
      clinicDates={clinicDates}
      assignmentsByDate={{}}
      highlightDateKey={null}
      deptId="d1"
      deptCode="MED"
      mode="assign"
      assignAction={async () => {}}
      unassignAction={async () => {}}
    />,
  );
}

describe("BuilderGrid", () => {
  it("renders header date columns chronologically even when clinicDates arrives out of order", () => {
    // Mirrors a real Term.clinicDates array: Postgres gives no ordering
    // guarantee, and the check-in feature's seed appends today's date to the
    // end regardless of where it falls chronologically.
    const outOfOrder = [d(2026, 9, 12), d(2026, 9, 26), d(2026, 8, 7)];
    const out = renderGrid(outOfOrder);
    // displayDate renders "August 7th" / "September 12th" / "September 26th"
    // with no year, which is unique enough within this single-year fixture.
    const augustIdx = out.indexOf("August 7th");
    const sept12Idx = out.indexOf("September 12th");
    const sept26Idx = out.indexOf("September 26th");
    expect(augustIdx).toBeGreaterThan(-1);
    expect(sept12Idx).toBeGreaterThan(-1);
    expect(sept26Idx).toBeGreaterThan(-1);
    // Chronological: August 7 must render before both September columns even
    // though it arrives last in the (unsorted) input array.
    expect(augustIdx).toBeLessThan(sept12Idx);
    expect(sept12Idx).toBeLessThan(sept26Idx);
  });

  it("renders body cells in the same chronological column order as the header", () => {
    const outOfOrder = [d(2026, 9, 12), d(2026, 9, 26), d(2026, 8, 7)];
    const out = renderGrid(outOfOrder);
    // Each empty grid cell carries its column's date as a hidden "dateKey"
    // input, so the cell order can be read off those attribute positions
    // independent of the header row.
    const augustCellIdx = out.indexOf('name="dateKey" value="2026-08-07"');
    const sept12CellIdx = out.indexOf('name="dateKey" value="2026-09-12"');
    const sept26CellIdx = out.indexOf('name="dateKey" value="2026-09-26"');
    expect(augustCellIdx).toBeGreaterThan(-1);
    expect(sept12CellIdx).toBeGreaterThan(-1);
    expect(sept26CellIdx).toBeGreaterThan(-1);
    expect(augustCellIdx).toBeLessThan(sept12CellIdx);
    expect(sept12CellIdx).toBeLessThan(sept26CellIdx);
  });

  it("does not mutate the caller's clinicDates array while sorting a copy for rendering", () => {
    const outOfOrder = [d(2026, 9, 12), d(2026, 9, 26), d(2026, 8, 7)];
    const originalOrder = [...outOfOrder];
    renderGrid(outOfOrder);
    expect(outOfOrder).toEqual(originalOrder);
  });
});
