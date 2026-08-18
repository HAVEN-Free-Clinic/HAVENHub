import { describe, expect, it } from "vitest";
import { attendingShiftsToEvents } from "./feed";
import type { MyAttendingSchedule, MyAttendingShift } from "../services/attending-portal";

const CTX = {
  orgName: "HAVEN Hub",
  startTime: "08:00",
  endTime: "13:00",
  timeZone: "America/New_York",
  host: "hub.example.org",
  baseUrl: "https://hub.example.org",
  clinicAddress: "800 Howard Ave, New Haven, CT (Yale Physicians Building)",
};

const PERSON_ID = "person-1";

/** Noon-UTC anchored, matching how the schema stores clinicDate. */
function clinicDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

function shift(overrides: Partial<MyAttendingShift> = {}): MyAttendingShift {
  return {
    assignmentId: "cda-1",
    clinicDayId: "day-1",
    clinicDate: clinicDate(2026, 5, 2),
    slot: { id: "slot-1", label: "9am-12pm", startTime: "09:00", endTime: "12:00" },
    alongside: [],
    isClosed: false,
    onCall: false,
    ...overrides,
  };
}

function schedule(shifts: MyAttendingShift[]): MyAttendingSchedule {
  return {
    attending: {
      id: "att-1",
      scheduleName: "Peggy Bia",
      fullName: "Bia, Margaret",
      credentials: "MD",
      isActive: true,
      specialty: null,
    },
    term: { id: "t1", name: "Spring 2026" },
    clinicDates: [],
    shifts,
    availableDates: null,
    availabilityUpdatedAt: null,
    availabilityLocked: false,
    pendingRequests: new Map(),
  };
}

describe("attendingShiftsToEvents", () => {
  /**
   * The reason this is not folded into shiftsToEvents: an attending's commitment
   * is a COLUMN, and stamping it with the clinic-wide window (08:00-13:00 here)
   * would put a three-hour shift on their calendar as a five-hour one.
   */
  it("uses the slot's own window, not the clinic-wide one", () => {
    const [event] = attendingShiftsToEvents(schedule([shift()]), PERSON_ID, CTX);
    // 09:00 and 12:00 America/New_York on 2026-05-02 (EDT, UTC-4).
    expect(event.start.toISOString()).toBe("2026-05-02T13:00:00.000Z");
    expect(event.end.toISOString()).toBe("2026-05-02T16:00:00.000Z");
  });

  it("names the column in the summary and lists whoever else is on it", () => {
    const [event] = attendingShiftsToEvents(
      schedule([shift({ alongside: ["Frank Bia"] })]),
      PERSON_ID,
      CTX,
    );
    expect(event.summary).toBe("HAVEN Hub: Attending (9am-12pm)");
    expect(event.description).toContain("With Frank Bia");
  });

  it("says the on-call week runs AFTER the date, not during it", () => {
    const [event] = attendingShiftsToEvents(schedule([shift({ onCall: true })]), PERSON_ID, CTX);
    expect(event.description).toContain("On call for the following week");
  });

  /**
   * The one thing a calendar must not do. Every attending-facing reader has
   * always honoured isClosed (see resolveOpenClinicDate); the feed is no
   * exception.
   */
  it("emits nothing for a closed clinic day", () => {
    expect(attendingShiftsToEvents(schedule([shift({ isClosed: true })]), PERSON_ID, CTX)).toEqual([]);
  });

  /**
   * ClinicSlot times are free-text "HH:MM" maintained by Faculty Relations, so an
   * inverted or malformed window is reachable. RFC 5545 forbids DTEND before
   * DTSTART, and throwing would take the whole feed down for every subscriber.
   */
  it("drops an event whose slot window is inverted or unparseable", () => {
    const inverted = shift({ slot: { id: "s", label: "Bad", startTime: "14:00", endTime: "09:00" } });
    const garbage = shift({ slot: { id: "s2", label: "Worse", startTime: "nonsense", endTime: "12:00" } });
    expect(attendingShiftsToEvents(schedule([inverted, garbage]), PERSON_ID, CTX)).toEqual([]);
  });

  it("namespaces the UID away from volunteer shift UIDs", () => {
    const [event] = attendingShiftsToEvents(schedule([shift()]), PERSON_ID, CTX);
    expect(event.uid).toBe("attending-day-1-slot-1-person-1@hub.example.org");
  });

  it("emits nothing when there is no active term", () => {
    const s = { ...schedule([shift()]), term: null };
    expect(attendingShiftsToEvents(s, PERSON_ID, CTX)).toEqual([]);
  });
});
