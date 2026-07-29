import { describe, it, expect, vi } from "vitest";

// today.ts resolves the display zone via getDisplayTimeZone (resolve.ts),
// which reads the display.timeZone setting from the database. Mock it so
// this test exercises only the zone-vs-UTC day-boundary logic, the same way
// format.test.ts and zone.test.ts pass explicit zones/instants rather than
// depending on live settings state.
vi.mock("./resolve", () => ({
  getDisplayTimeZone: vi.fn(async () => "America/New_York"),
}));

import { displayTodayKey } from "./today";

describe("displayTodayKey", () => {
  it("a mid-afternoon Eastern instant yields that Eastern calendar day", () => {
    // 2026-06-13T18:00Z == 2:00 PM EDT -- same calendar day in both zones, so
    // this alone would pass against a naive isoDateKey(new Date()) too.
    return expect(displayTodayKey(new Date("2026-06-13T18:00:00Z"))).resolves.toBe("2026-06-13");
  });

  it("a 9pm Eastern instant (already tomorrow in UTC) still yields the Eastern day", () => {
    // 2026-06-13T01:00Z == 2026-06-12 21:00 EDT. A raw isoDateKey(new Date())
    // would read the UTC calendar day and answer "2026-06-13" -- tomorrow by
    // Eastern reckoning. This is the entire reason displayTodayKey exists.
    return expect(displayTodayKey(new Date("2026-06-13T01:00:00Z"))).resolves.toBe("2026-06-12");
  });

  it("defaults to the current instant when none is supplied", async () => {
    const key = await displayTodayKey();
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
