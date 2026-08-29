import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AttendingDayView } from "./attending-day-view";
import type { AttendingScheduleRow } from "@/modules/schedule/services/attendings";

function d(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

function row(over: Partial<AttendingScheduleRow> = {}): AttendingScheduleRow {
  return {
    dateKey: "2026-09-05",
    clinicDate: d(2026, 9, 5),
    isClinicDate: true,
    isClosed: false,
    storedClosed: false,
    closedNote: null,
    onCallAttendingId: null,
    onCallName: null,
    specialtyId: null,
    directorName: null,
    proceduresBooked: null,
    slots: [],
    ...over,
  } as AttendingScheduleRow;
}

function render(r: AttendingScheduleRow) {
  return renderToStaticMarkup(
    <AttendingDayView
      row={r}
      slots={[]}
      specialties={[]}
      options={[]}
      termId="t1"
      termName="Fall 2026"
      editable
      saveAction={async () => {}}
    />,
  );
}

describe("AttendingDayView closure", () => {
  it("offers no closure control, even to an editor", () => {
    // Closure is owned by admin.manage_terms and set in Admin > Terms.
    const out = render(row({ storedClosed: true, isClosed: true }));
    expect(out).not.toContain('name="isClosed"');
    expect(out).not.toContain('name="closedMarker"');
  });

  it("states the closure and its reason, and names the owner", () => {
    const out = render(
      row({ storedClosed: true, isClosed: true, closedNote: "Thanksgiving" }),
    );
    expect(out).toContain("Clinic closed");
    expect(out).toContain("Thanksgiving");
    expect(out).toContain("Admin &gt; Terms");
  });

  it("says a reason was not recorded rather than going silent", () => {
    const out = render(row({ storedClosed: true, isClosed: true, closedNote: null }));
    expect(out).toContain("No reason was recorded.");
  });

  it("says nothing about closure on an open date", () => {
    const out = render(row());
    expect(out).not.toContain("Clinic closed");
  });
});
