import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BuilderAvailabilityView } from "./builder-availability-view";
import type { BuilderMember } from "@/modules/schedule/services/builder";

/** Noon-UTC anchored calendar date, matching how the schema stores clinicDate. */
function d(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

const member: BuilderMember = {
  membershipId: "mem-1",
  person: { id: "p1", name: "Alice Volunteer", spanishVerified: false, licensedRN: false },
  kind: "VOLUNTEER",
  availability: { tier: "SELF", dates: [] },
  overrideActive: false,
  acknowledgePending: false,
  legacyNote: null,
  intake: { minShiftsWanted: null, additionalShiftAvailability: null, feedback: null },
};

const noop = async () => {};

// Mirrors a real Term.clinicDates array: Postgres gives no ordering
// guarantee, and the check-in feature's seed appends today's date to the end
// regardless of where it falls chronologically.
const OUT_OF_ORDER = [d(2026, 9, 12), d(2026, 9, 26), d(2026, 8, 7)];

describe("BuilderAvailabilityView", () => {
  it("renders the editable checkbox pills chronologically even when clinicDates arrives out of order", () => {
    const out = renderToStaticMarkup(
      <BuilderAvailabilityView
        members={[member]}
        clinicDates={OUT_OF_ORDER}
        editable
        saveOverrideAction={noop}
        clearOverrideAction={noop}
        acknowledgeAction={noop}
      />,
    );
    const augustIdx = out.indexOf('value="2026-08-07"');
    const sept12Idx = out.indexOf('value="2026-09-12"');
    const sept26Idx = out.indexOf('value="2026-09-26"');
    expect(augustIdx).toBeGreaterThan(-1);
    expect(sept12Idx).toBeGreaterThan(-1);
    expect(sept26Idx).toBeGreaterThan(-1);
    // Chronological: August 7 must render before both September checkboxes
    // even though it arrives last in the (unsorted) input array.
    expect(augustIdx).toBeLessThan(sept12Idx);
    expect(sept12Idx).toBeLessThan(sept26Idx);
  });

  it("renders the read-only pills chronologically even when clinicDates arrives out of order", () => {
    const out = renderToStaticMarkup(
      <BuilderAvailabilityView
        members={[member]}
        clinicDates={OUT_OF_ORDER}
        editable={false}
        saveOverrideAction={noop}
        clearOverrideAction={noop}
        acknowledgeAction={noop}
      />,
    );
    // displayDate renders "August 7th" / "September 12th" / "September 26th"
    // with no year, which is unique enough within this single-year fixture.
    const augustIdx = out.indexOf("August 7th");
    const sept12Idx = out.indexOf("September 12th");
    const sept26Idx = out.indexOf("September 26th");
    expect(augustIdx).toBeGreaterThan(-1);
    expect(sept12Idx).toBeGreaterThan(-1);
    expect(sept26Idx).toBeGreaterThan(-1);
    expect(augustIdx).toBeLessThan(sept12Idx);
    expect(sept12Idx).toBeLessThan(sept26Idx);
  });

  it("does not mutate the caller's clinicDates array while sorting a copy for rendering", () => {
    const outOfOrder = [d(2026, 9, 12), d(2026, 9, 26), d(2026, 8, 7)];
    const originalOrder = [...outOfOrder];
    renderToStaticMarkup(
      <BuilderAvailabilityView
        members={[member]}
        clinicDates={outOfOrder}
        editable
        saveOverrideAction={noop}
        clearOverrideAction={noop}
        acknowledgeAction={noop}
      />,
    );
    expect(outOfOrder).toEqual(originalOrder);
  });
});
