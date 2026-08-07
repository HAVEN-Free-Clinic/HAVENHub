import { describe, expect, it } from "vitest";
import { buildCalendar, escapeText, foldLine, formatUtcStamp, type CalendarEvent } from "./ics";

const NOW = new Date("2026-08-06T15:00:00.000Z");

const OPTS = { calendarName: "HAVEN Hub", timeZone: "America/New_York", now: NOW };

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    uid: "shift-abc123@havenhub.test",
    start: new Date("2026-02-08T13:00:00.000Z"),
    end: new Date("2026-02-08T18:00:00.000Z"),
    summary: "HAVEN Hub: Internal Medicine",
    description: "Volunteer",
    ...overrides,
  };
}

describe("formatUtcStamp", () => {
  it("renders an instant as a compact UTC date-time", () => {
    expect(formatUtcStamp(new Date("2026-02-08T13:00:00.000Z"))).toBe("20260208T130000Z");
  });
});

describe("escapeText", () => {
  it("escapes backslash, semicolon, comma, and newline", () => {
    expect(escapeText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
  });

  it("escapes the backslash before anything else, so escapes are not double-escaped", () => {
    expect(escapeText("100\\%")).toBe("100\\\\%");
  });

  it("normalizes CRLF to a single escaped newline", () => {
    expect(escapeText("a\r\nb")).toBe("a\\nb");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeText("Internal Medicine")).toBe("Internal Medicine");
  });
});

describe("foldLine", () => {
  it("leaves a line of 75 octets or fewer alone", () => {
    const line = "X".repeat(75);
    expect(foldLine(line)).toBe(line);
  });

  it("folds a long line with CRLF plus a leading space", () => {
    const folded = foldLine("X".repeat(80));
    expect(folded).toBe(`${"X".repeat(75)}\r\n ${"X".repeat(5)}`);
  });

  it("counts octets, not characters, so multi-byte text folds early", () => {
    // Each emoji is 4 octets, so 20 of them is 80 octets and must fold.
    expect(foldLine("\u{1F600}".repeat(20))).toContain("\r\n ");
  });

  it("never splits a multi-byte codepoint across a fold", () => {
    const folded = foldLine("\u{1F600}".repeat(20));
    for (const chunk of folded.split("\r\n ")) {
      expect(chunk).not.toContain("�");
      expect(Buffer.from(chunk, "utf8").toString("utf8")).toBe(chunk);
    }
  });
});

describe("buildCalendar", () => {
  it("uses CRLF line endings throughout", () => {
    const ics = buildCalendar([event()], OPTS);
    expect(ics).toContain("\r\n");
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("wraps events in a well-formed VCALENDAR", () => {
    const ics = buildCalendar([event()], OPTS);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("METHOD:PUBLISH");
  });

  it("emits the calendar name and time zone hints", () => {
    const ics = buildCalendar([event()], OPTS);
    expect(ics).toContain("X-WR-CALNAME:HAVEN Hub");
    expect(ics).toContain("X-WR-TIMEZONE:America/New_York");
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT12H");
  });

  it("emits start and end as UTC instants, so no VTIMEZONE is needed", () => {
    const ics = buildCalendar([event()], OPTS);
    expect(ics).toContain("DTSTART:20260208T130000Z");
    expect(ics).toContain("DTEND:20260208T180000Z");
    expect(ics).not.toContain("BEGIN:VTIMEZONE");
  });

  it("marks the event busy and confirmed", () => {
    const ics = buildCalendar([event()], OPTS);
    expect(ics).toContain("TRANSP:OPAQUE");
    expect(ics).toContain("STATUS:CONFIRMED");
  });

  it("emits LOCATION when the event has one, escaping the commas in an address", () => {
    const ics = buildCalendar(
      [event({ location: "800 Howard Ave, New Haven, CT (Yale Physicians Building)" })],
      OPTS,
    );
    expect(ics).toContain("LOCATION:800 Howard Ave\\, New Haven\\, CT (Yale Physicians Building)");
  });

  it("omits the LOCATION line entirely when the event has none", () => {
    // An empty LOCATION is not the same as no LOCATION: clients render the
    // empty one as a blank location row and Google still tries to geocode it.
    expect(buildCalendar([event()], OPTS)).not.toContain("LOCATION");
  });

  it("omits LOCATION for an empty-string location rather than emitting a blank one", () => {
    expect(buildCalendar([event({ location: "" })], OPTS)).not.toContain("LOCATION");
  });

  it("folds a LOCATION long enough to exceed one content line", () => {
    const long = "800 Howard Avenue, New Haven, Connecticut 06519 (Yale Physicians Building, Ground Floor)";
    const ics = buildCalendar([event({ location: long })], OPTS);
    const locationLine = ics.split("\r\n").find((l) => l.startsWith("LOCATION:"))!;
    expect(Buffer.from(locationLine, "utf8").length).toBeLessThanOrEqual(75);
    // The remainder continues on a folded line, so the address is not truncated.
    expect(ics).toContain("Ground Floor");
  });

  it("stamps every event with the injected now, never a wall clock", () => {
    const ics = buildCalendar([event()], OPTS);
    expect(ics).toContain("DTSTAMP:20260806T150000Z");
  });

  it("emits SEQUENCE and LAST-MODIFIED on every event so Outlook notices an edited shift", () => {
    const ics = buildCalendar([event()], OPTS);
    expect(ics).toContain("SEQUENCE:0");
    // LAST-MODIFIED comes from the injected `now`, matching DTSTAMP exactly,
    // not a fresh clock read.
    expect(ics).toContain("LAST-MODIFIED:20260806T150000Z");
  });

  it("keeps the UID stable across regenerations", () => {
    const a = buildCalendar([event()], OPTS);
    const b = buildCalendar([event()], { ...OPTS, now: new Date("2026-09-01T00:00:00.000Z") });
    expect(a).toContain("UID:shift-abc123@havenhub.test");
    expect(b).toContain("UID:shift-abc123@havenhub.test");
  });

  it("escapes a department name containing a comma", () => {
    const ics = buildCalendar([event({ summary: "HAVEN Hub: Cardiology, Adult" })], OPTS);
    expect(ics).toContain("SUMMARY:HAVEN Hub: Cardiology\\, Adult");
  });

  it("produces a valid empty calendar when there are no events", () => {
    const ics = buildCalendar([], OPTS);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("emits one VEVENT per shift", () => {
    const ics = buildCalendar([event({ uid: "a@x" }), event({ uid: "b@x" })], OPTS);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });
});
