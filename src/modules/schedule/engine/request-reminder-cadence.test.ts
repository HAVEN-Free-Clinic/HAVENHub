import { describe, expect, it } from "vitest";
import {
  CADENCE,
  byUrgencyThenDate,
  cadenceFor,
  isRemindable,
  reminderUrgency,
  URGENT_WINDOW_DAYS,
} from "./request-reminder-cadence";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("reminderUrgency", () => {
  it("treats a clinic inside the urgent window as urgent", () => {
    expect(reminderUrgency({ requesterDateKey: "2026-09-19", todayKey: "2026-09-14" })).toBe("URGENT");
  });

  // The whole point of the feature: a drop filed two days before clinic must
  // escalate, because the flat 48-hour rule would not have reminded anyone
  // until the clinic had already happened.
  it("treats a clinic two days out as urgent", () => {
    expect(reminderUrgency({ requesterDateKey: "2026-09-19", todayKey: "2026-09-17" })).toBe("URGENT");
  });

  it("treats today's clinic as urgent", () => {
    expect(reminderUrgency({ requesterDateKey: "2026-09-19", todayKey: "2026-09-19" })).toBe("URGENT");
  });

  it("is urgent exactly at the window boundary", () => {
    expect(reminderUrgency({ requesterDateKey: "2026-09-19", todayKey: "2026-09-12" })).toBe("URGENT");
  });

  it("is normal one day beyond the window", () => {
    expect(reminderUrgency({ requesterDateKey: "2026-09-19", todayKey: "2026-09-11" })).toBe("NORMAL");
  });

  it("keeps a distant clinic on the normal cadence", () => {
    expect(reminderUrgency({ requesterDateKey: "2026-11-21", todayKey: "2026-09-14" })).toBe("NORMAL");
  });

  // A shift that already happened cannot be fixed by approving anything, so
  // escalating it to a daily nag would be pure noise. It still needs
  // dispositioning for the record, hence NORMAL rather than "never remind".
  it("does NOT escalate a clinic date that has already passed", () => {
    expect(reminderUrgency({ requesterDateKey: "2026-09-05", todayKey: "2026-09-14" })).toBe("NORMAL");
  });

  // Called from the cron path, so a malformed key must degrade rather than throw.
  it("degrades an unparseable date key to the normal cadence", () => {
    expect(reminderUrgency({ requesterDateKey: "not-a-date", todayKey: "2026-09-14" })).toBe("NORMAL");
  });

  it("keeps URGENT_WINDOW_DAYS covering a full weekly clinic cycle", () => {
    expect(URGENT_WINDOW_DAYS).toBeGreaterThanOrEqual(7);
  });
});

describe("isRemindable", () => {
  it("holds an urgent request until it is 12 hours old", () => {
    expect(isRemindable({ urgency: "URGENT", ageMs: 11 * HOUR })).toBe(false);
    expect(isRemindable({ urgency: "URGENT", ageMs: 12 * HOUR })).toBe(true);
  });

  // The pre-existing cadence, unchanged: a request with room to breathe is not
  // escalated just because this feature exists.
  it("holds a normal request until it is 48 hours old", () => {
    expect(isRemindable({ urgency: "NORMAL", ageMs: 47 * HOUR })).toBe(false);
    expect(isRemindable({ urgency: "NORMAL", ageMs: 48 * HOUR })).toBe(true);
  });

  it("reminds urgent requests daily and normal ones every three days", () => {
    expect(cadenceFor("URGENT").throttleMs).toBe(1 * DAY);
    expect(cadenceFor("NORMAL").throttleMs).toBe(3 * DAY);
  });

  // The cron's initial query uses the loosest minAgeMs across all cadences and
  // then re-filters per request. If a cadence ever became looser than URGENT's,
  // that query would silently stop fetching rows it still needs.
  it("keeps URGENT the loosest age gate, which the cron's prefilter relies on", () => {
    const loosest = Math.min(...Object.values(CADENCE).map((c) => c.minAgeMs));
    expect(loosest).toBe(CADENCE.URGENT.minAgeMs);
  });
});

describe("byUrgencyThenDate", () => {
  // Each approver gets at most one dispatch claim per day, so this ordering
  // decides which request their single reminder is actually about.
  it("puts urgent requests ahead of normal ones", () => {
    const sorted = [
      { urgency: "NORMAL" as const, requesterDateKey: "2026-09-05" },
      { urgency: "URGENT" as const, requesterDateKey: "2026-11-21" },
    ].sort(byUrgencyThenDate);
    expect(sorted[0].urgency).toBe("URGENT");
  });

  it("puts the soonest clinic first within the same urgency", () => {
    const sorted = [
      { urgency: "URGENT" as const, requesterDateKey: "2026-09-19" },
      { urgency: "URGENT" as const, requesterDateKey: "2026-09-13" },
    ].sort(byUrgencyThenDate);
    expect(sorted[0].requesterDateKey).toBe("2026-09-13");
  });
});
