import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AvailabilityRequests } from "./availability-requests";
import type { AvailabilityRequestRow } from "@/modules/schedule/services/availability-requests";

/** Noon-UTC anchored, matching how the schema stores clinicDate. */
function d(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

const CLINIC_DATES = [d(2026, 9, 12), d(2026, 9, 26), d(2026, 9, 5)];

const baseRow: AvailabilityRequestRow = {
  contractId: "c1",
  departmentId: "dept-1",
  personId: "p1",
  membershipId: "mem-1",
  personName: "Val Volunteer",
  legalFirstName: "Val",
  lastName: "Volunteer",
  request: "Please drop me from Sep 12.",
  currentDates: [d(2026, 9, 5), d(2026, 9, 12)],
  tier: "BASELINE",
  decision: null,
};

const noop = async () => {};

function render(rows: AvailabilityRequestRow[]) {
  return renderToStaticMarkup(
    <AvailabilityRequests
      rows={rows}
      clinicDates={CLINIC_DATES}
      applyAction={noop}
      dismissAction={noop}
      timeZone="America/New_York"
    />,
  );
}

describe("AvailabilityRequests", () => {
  it("renders nothing at all when the department has no requests", () => {
    expect(render([])).toBe("");
  });

  it("shows the request in the member's own words with their current dates ticked", () => {
    const out = render([baseRow]);

    expect(out).toContain("Val Volunteer");
    expect(out).toContain("Please drop me from Sep 12.");
    // Ticked: the two dates they are currently available for.
    expect(out).toMatch(/value="2026-09-05"[^>]*checked|checked[^>]*value="2026-09-05"/);
    expect(out).toMatch(/value="2026-09-12"[^>]*checked|checked[^>]*value="2026-09-12"/);
    // Offered but not ticked.
    expect(out).toContain('value="2026-09-26"');
    expect(out).not.toMatch(/value="2026-09-26"[^>]*checked|checked[^>]*value="2026-09-26"/);
    expect(out).toContain("Apply availability");
  });

  it("renders the clinic dates chronologically even when the term's array is unordered", () => {
    const out = render([baseRow]);
    const sep5 = out.indexOf('value="2026-09-05"');
    const sep12 = out.indexOf('value="2026-09-12"');
    const sep26 = out.indexOf('value="2026-09-26"');

    expect(sep5).toBeGreaterThan(-1);
    expect(sep5).toBeLessThan(sep12);
    expect(sep12).toBeLessThan(sep26);
  });

  it("carries the ids the server action needs on both forms", () => {
    const out = render([baseRow]);
    expect(out).toContain('name="contractId" value="c1"');
    expect(out).toContain('name="departmentId" value="dept-1"');
    expect(out).toContain('name="dismissNote"');
  });

  it("offers no apply form for someone who is not on the roster yet", () => {
    const out = render([{ ...baseRow, membershipId: null, personId: null }]);

    expect(out).toContain("Not on the roster yet");
    // Read-only pills: the dates are shown, but there is nothing to tick and no
    // membership to write an override to.
    expect(out).not.toContain('name="dates"');
    expect(out).not.toContain("Apply availability");
    // Dismiss stays, so the row can still be cleared.
    expect(out).toContain("Dismiss");
  });

  it("moves a decided request into the decisions list instead of the queue", () => {
    const out = render([
      {
        ...baseRow,
        decision: {
          outcome: "APPLIED",
          note: null,
          decidedAt: new Date("2026-09-15T14:00:00Z"),
          decidedByName: "Dana Director",
        },
      },
    ]);

    expect(out).toContain("Recent decisions");
    expect(out).toContain("availability updated");
    expect(out).toContain("Dana Director");
    // No apply form for something already decided.
    expect(out).not.toContain("Apply availability");
  });

  it("shows a dismissal with the note the director left", () => {
    const out = render([
      {
        ...baseRow,
        decision: {
          outcome: "DISMISSED",
          note: "Spoke to them, no change needed.",
          decidedAt: new Date("2026-09-15T14:00:00Z"),
          decidedByName: "Dana Director",
        },
      },
    ]);

    expect(out).toContain("dismissed");
    expect(out).toContain("Spoke to them, no change needed.");
  });
});
