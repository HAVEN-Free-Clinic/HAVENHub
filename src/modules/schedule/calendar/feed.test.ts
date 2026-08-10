import { describe, expect, it } from "vitest";
import type { Department } from "@prisma/client";
import { shiftsToEvents } from "./feed";
import type { MyTermSchedule } from "../services/schedule";

/** Full Department shape with empty placeholders for the fields shiftsToEvents doesn't read. */
function department(id: string, name: string, code: string): Department {
  return {
    id,
    name,
    code,
    isActive: true,
    idealHeadcount: null,
    patientCapacityPerProvider: null,
    requiresEpicDirector: "NONE",
    requiresEpicVolunteer: "NONE",
    epicGuidance: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const CTX = {
  orgName: "HAVEN Hub",
  startTime: "08:00",
  endTime: "13:00",
  timeZone: "America/New_York",
  host: "hub.example.org",
  baseUrl: "https://hub.example.org",
  clinicAddress: "800 Howard Ave, New Haven, CT (Yale Physicians Building)",
};

/** Noon-UTC anchored calendar date, matching how the schema stores clinicDate. */
function clinicDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

const PERSON_ID = "person-1";

function term(shifts: MyTermSchedule["shifts"], overrides: Partial<MyTermSchedule["term"]> = {}): MyTermSchedule {
  return {
    term: { id: "t1", name: "Spring 2026", ...overrides },
    shifts,
    // The renderer reads only `term.id`, `term.name`, and `shifts`; the rest
    // of MyTermSchedule is irrelevant here and is cast away.
  } as unknown as MyTermSchedule;
}

function shift(overrides: Partial<MyTermSchedule["shifts"][number]> = {}) {
  return {
    clinicDate: clinicDate(2026, 2, 8),
    department: department("d1", "Internal Medicine", "IM"),
    role: "VOLUNTEER",
    tags: { triage: false, walkin: false, cc: false, remote: false },
    ...overrides,
  } as MyTermSchedule["shifts"][number];
}

describe("shiftsToEvents", () => {
  it("places a shift in the configured local window", () => {
    // 08:00 America/New_York on 2026-02-08 is EST (UTC-5), so 13:00Z.
    const [event] = shiftsToEvents([term([shift()])], PERSON_ID, CTX);
    expect(event!.start.toISOString()).toBe("2026-02-08T13:00:00.000Z");
    expect(event!.end.toISOString()).toBe("2026-02-08T18:00:00.000Z");
  });

  it("shifts by an hour across the DST boundary, from the same configured window", () => {
    // 08:00 America/New_York on 2026-07-11 is EDT (UTC-4), so 12:00Z not 13:00Z.
    const [event] = shiftsToEvents([term([shift({ clinicDate: clinicDate(2026, 7, 11) })])], PERSON_ID, CTX);
    expect(event!.start.toISOString()).toBe("2026-07-11T12:00:00.000Z");
    expect(event!.end.toISOString()).toBe("2026-07-11T17:00:00.000Z");
  });

  it("names the event with the org name and department", () => {
    const [event] = shiftsToEvents([term([shift()])], PERSON_ID, CTX);
    expect(event!.summary).toBe("HAVEN Hub: Internal Medicine");
  });

  it("describes the role and the term", () => {
    const [event] = shiftsToEvents([term([shift()])], PERSON_ID, CTX);
    expect(event!.description).toContain("Volunteer");
    expect(event!.description).toContain("Spring 2026");
  });

  it("lists only the tags that are set", () => {
    const [event] = shiftsToEvents(
      [term([shift({ tags: { triage: true, walkin: false, cc: false, remote: true } })])],
      PERSON_ID,
      CTX,
    );
    expect(event!.description).toContain("Triage");
    expect(event!.description).toContain("Remote");
    expect(event!.description).not.toContain("Walk-in");
    expect(event!.description).not.toContain("Care coordinator");
  });

  it("links back to the schedule page", () => {
    const [event] = shiftsToEvents([term([shift()])], PERSON_ID, CTX);
    expect(event!.description).toContain("https://hub.example.org/schedule");
  });

  it("builds a UID that is stable for the same person, date, and department", () => {
    const a = shiftsToEvents([term([shift()])], PERSON_ID, CTX);
    const b = shiftsToEvents([term([shift()])], PERSON_ID, CTX);
    expect(a[0]!.uid).toBe(b[0]!.uid);
    expect(a[0]!.uid).toContain("@hub.example.org");
  });

  it("gives different departments on the same day different UIDs", () => {
    const events = shiftsToEvents(
      [
        term([
          shift(),
          shift({ department: department("d2", "Pediatrics", "PEDS") }),
        ]),
      ],
      PERSON_ID,
      CTX,
    );
    expect(events[0]!.uid).not.toBe(events[1]!.uid);
  });

  it("flattens shifts across multiple terms", () => {
    const events = shiftsToEvents(
      [term([shift()]), term([shift({ clinicDate: clinicDate(2026, 9, 5) })], { id: "t2" })],
      PERSON_ID,
      CTX,
    );
    expect(events).toHaveLength(2);
  });

  it("returns nothing for a member with no shifts", () => {
    expect(shiftsToEvents([term([])], PERSON_ID, CTX)).toEqual([]);
  });

  it("puts the clinic address on an on-site shift", () => {
    const [event] = shiftsToEvents([term([shift()])], PERSON_ID, CTX);
    expect(event!.location).toBe("800 Howard Ave, New Haven, CT (Yale Physicians Building)");
  });

  // A remote shift with the clinic address would send a member across town for
  // a shift they are doing from home, and clients turn location into
  // directions and a travel-time estimate.
  it("leaves a remote shift with no location at all", () => {
    const [event] = shiftsToEvents(
      [term([shift({ tags: { triage: false, walkin: false, cc: false, remote: true } })])],
      PERSON_ID,
      CTX,
    );
    expect(event!.location).toBeUndefined();
    expect(event!.description).toContain("Remote");
  });

  it("omits the location when no clinic address is configured", () => {
    const [event] = shiftsToEvents([term([shift()])], PERSON_ID, { ...CTX, clinicAddress: "" });
    expect(event!.location).toBeUndefined();
  });

  it("gives two terms sharing a clinic date and department distinct UIDs, so a rollover-week shift never collapses onto another", () => {
    // mySchedule can return the live term and a PLANNING next term together.
    // If both happen to have a shift in the same department on the same
    // clinic date -- plausible right at a term rollover -- the UID must still
    // distinguish them, or one shift silently disappears from the calendar.
    const events = shiftsToEvents(
      [term([shift()], { id: "live-term" }), term([shift()], { id: "next-term" })],
      PERSON_ID,
      CTX,
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.uid).not.toBe(events[1]!.uid);
  });

  it("gives the same shift different UIDs for different people, so two members' feeds never collide", () => {
    const a = shiftsToEvents([term([shift()])], "person-a", CTX);
    const b = shiftsToEvents([term([shift()])], "person-b", CTX);
    expect(a[0]!.uid).not.toBe(b[0]!.uid);
  });

  it("drops an event whose configured window is inverted (end at or before start)", () => {
    // resetSetting deletes a setting row without running setSetting's
    // cross-field validate hook, so an admin can reset only the start time and
    // leave a stored end time that is now earlier, e.g. start resets to 08:00
    // while a previously-valid end of 07:00 remains stored.
    const invertedCtx = { ...CTX, startTime: "08:00", endTime: "07:00" };
    expect(shiftsToEvents([term([shift()])], PERSON_ID, invertedCtx)).toEqual([]);
  });

  it("drops an event whose configured window has zero duration (end equals start)", () => {
    const zeroCtx = { ...CTX, startTime: "08:00", endTime: "08:00" };
    expect(shiftsToEvents([term([shift()])], PERSON_ID, zeroCtx)).toEqual([]);
  });
});
