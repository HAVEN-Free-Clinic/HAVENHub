import { describe, expect, it } from "vitest";
import { dueDraftReminder, type DraftReminderState } from "./draft-reminder-cadence";

const NOW = new Date("2026-09-05T13:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function state(overrides: Partial<DraftReminderState> = {}): DraftReminderState {
  return {
    status: "DRAFT",
    cycleStatus: "OPEN",
    opensAt: null,
    closesAt: new Date(NOW.getTime() + 30 * DAY),
    updatedAt: new Date(NOW.getTime() - 3 * DAY),
    lastSentAt: null,
    routineCount: 0,
    finalCount: 0,
    ...overrides,
  };
}

describe("dueDraftReminder", () => {
  it("waits for 48 quiet hours before the first routine reminder", () => {
    expect(dueDraftReminder(state({ updatedAt: new Date(NOW.getTime() - DAY) }), NOW)).toBeNull();
    expect(dueDraftReminder(state({ updatedAt: new Date(NOW.getTime() - 2 * DAY) }), NOW)).toBe("routine");
  });

  it("spaces later routine reminders weekly and caps them at three", () => {
    expect(dueDraftReminder(state({ routineCount: 1, updatedAt: new Date(NOW.getTime() - 6 * DAY) }), NOW)).toBeNull();
    expect(dueDraftReminder(state({ routineCount: 1, updatedAt: new Date(NOW.getTime() - 7 * DAY) }), NOW)).toBe("routine");
    expect(dueDraftReminder(state({ routineCount: 3, updatedAt: new Date(NOW.getTime() - 20 * DAY) }), NOW)).toBeNull();
  });

  it("uses the independent 7/3/1-day stream near a deadline", () => {
    expect(dueDraftReminder(state({ closesAt: new Date(NOW.getTime() + 7 * DAY) }), NOW)).toBe("final");
    expect(dueDraftReminder(state({ closesAt: new Date(NOW.getTime() + 4 * DAY), finalCount: 1 }), NOW)).toBeNull();
    expect(dueDraftReminder(state({ closesAt: new Date(NOW.getTime() + 3 * DAY), finalCount: 1 }), NOW)).toBe("final");
    expect(dueDraftReminder(state({ closesAt: new Date(NOW.getTime() + DAY), finalCount: 2 }), NOW)).toBe("final");
    expect(dueDraftReminder(state({ closesAt: new Date(NOW.getTime() + DAY), finalCount: 3 }), NOW)).toBeNull();
  });

  it("postpones a deadline reminder when the draft was just saved", () => {
    expect(dueDraftReminder(state({ closesAt: new Date(NOW.getTime() + 3 * DAY), updatedAt: new Date(NOW.getTime() - 10 * 60 * 60 * 1000) }), NOW)).toBeNull();
  });

  it("never reminds drafts outside an open cycle window", () => {
    expect(dueDraftReminder(state({ cycleStatus: "CLOSED" }), NOW)).toBeNull();
    expect(dueDraftReminder(state({ opensAt: new Date(NOW.getTime() + DAY) }), NOW)).toBeNull();
    expect(dueDraftReminder(state({ closesAt: new Date(NOW.getTime() - 1) }), NOW)).toBeNull();
    expect(dueDraftReminder(state({ status: "SUBMITTED" }), NOW)).toBeNull();
  });
});
