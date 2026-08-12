import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/modules/schedule/services/schedule", () => ({ mySchedule: vi.fn() }));
// displayTodayKey (platform/dates/today.ts) resolves "today" via getDisplayTimeZone,
// which reads a DB-backed setting. Pin the zone so the day-key comparison under test
// is deterministic and this stays a pure unit test, the same way dates/today.test.ts
// and actions.posthog.test.ts stub this same dependency.
vi.mock("@/platform/dates/resolve", () => ({
  getDisplayTimeZone: vi.fn(async () => "America/New_York"),
}));

import { mySchedule } from "@/modules/schedule/services/schedule";
import { myNextShiftTool } from "./scheduling";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function shift(clinicDate: string, departmentName: string) {
  return {
    clinicDate: new Date(clinicDate),
    department: { name: departmentName },
    role: "VOLUNTEER",
    tags: { triage: false, walkin: false, cc: false, remote: false },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
});

describe("my_next_shift", () => {
  it("returns the earliest upcoming shift in the live term", async () => {
    mocked(mySchedule).mockResolvedValue({
      terms: [
        {
          isLive: true,
          shifts: [shift("2026-09-26T00:00:00Z", "Internal Medicine"), shift("2026-09-12T00:00:00Z", "Triage")],
        },
      ],
    });

    const text = await myNextShiftTool.run({ personId: "p1" }, {});

    expect(text).toContain("Triage");
    expect(text).not.toContain("Internal Medicine");
  });

  it("reports the calendar day the shift is actually on, not the day before", async () => {
    mocked(mySchedule).mockResolvedValue({
      terms: [{ isLive: true, shifts: [shift("2026-09-12T00:00:00Z", "Triage")] }],
    });

    const text = await myNextShiftTool.run({ personId: "p1" }, {});

    // clinicDate is stored at UTC midnight. Formatting it in America/New_York
    // would render "Sep 11" and quietly tell the member the wrong day.
    expect(text).toContain("Sep 12");
    expect(text).not.toContain("Sep 11");
  });

  it("ignores shifts in the past", async () => {
    mocked(mySchedule).mockResolvedValue({
      terms: [{ isLive: true, shifts: [shift("2026-09-01T00:00:00Z", "Triage")] }],
    });

    const text = await myNextShiftTool.run({ personId: "p1" }, {});

    expect(text).toMatch(/no upcoming shifts/i);
  });

  it("says so plainly when there are no shifts at all", async () => {
    mocked(mySchedule).mockResolvedValue({ terms: [] });

    const text = await myNextShiftTool.run({ personId: "p1" }, {});

    expect(text).toMatch(/no upcoming shifts/i);
  });

  it("reads only the caller's own schedule", async () => {
    mocked(mySchedule).mockResolvedValue({ terms: [] });

    await myNextShiftTool.run({ personId: "p1" }, {});

    expect(mocked(mySchedule)).toHaveBeenCalledWith("p1");
    expect(mocked(mySchedule)).toHaveBeenCalledTimes(1);
  });

  it("takes no input at all, so nothing about the request is model-chosen", () => {
    expect(Object.keys(myNextShiftTool.inputSchema.shape)).toEqual([]);
  });

  it("treats a same-day shift as upcoming, not past", async () => {
    // 11am ET on the shift's own day. clinicDate is UTC midnight for that same
    // day, so a raw `clinicDate >= now` comparison would already read this
    // shift as in the past by this point in the morning.
    vi.setSystemTime(new Date("2026-09-12T15:00:00Z"));
    mocked(mySchedule).mockResolvedValue({
      terms: [{ isLive: true, shifts: [shift("2026-09-12T00:00:00Z", "Triage")] }],
    });

    const text = await myNextShiftTool.run({ personId: "p1" }, {});

    expect(text).not.toMatch(/no upcoming shifts/i);
    expect(text).toContain("Triage");
  });

  it("finds a shift in a next (non-live) term when the live term is exhausted", async () => {
    mocked(mySchedule).mockResolvedValue({
      terms: [
        { isLive: true, shifts: [shift("2026-09-01T00:00:00Z", "Triage")] },
        { isLive: false, shifts: [shift("2026-09-20T00:00:00Z", "Internal Medicine")] },
      ],
    });

    const text = await myNextShiftTool.run({ personId: "p1" }, {});

    expect(text).toContain("Internal Medicine");
    expect(text).not.toMatch(/no upcoming shifts/i);
  });

  it("picks the earliest shift across terms, not just the live term's", async () => {
    mocked(mySchedule).mockResolvedValue({
      terms: [
        { isLive: true, shifts: [shift("2026-09-26T00:00:00Z", "Internal Medicine")] },
        { isLive: false, shifts: [shift("2026-09-15T00:00:00Z", "Triage")] },
      ],
    });

    const text = await myNextShiftTool.run({ personId: "p1" }, {});

    expect(text).toContain("Triage");
    expect(text).not.toContain("Internal Medicine");
  });
});
