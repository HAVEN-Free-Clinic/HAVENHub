import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/modules/schedule/services/schedule", () => ({ mySchedule: vi.fn() }));
// displayTodayKey (platform/dates/today.ts) resolves "today" via getDisplayTimeZone,
// which reads a DB-backed setting. Pin the zone so the day-key comparison under test
// is deterministic and this stays a pure unit test, the same way dates/today.test.ts
// and actions.posthog.test.ts stub this same dependency.
vi.mock("@/platform/dates/resolve", () => ({
  getDisplayTimeZone: vi.fn(async () => "America/New_York"),
}));

vi.mock("./links", () => ({ hubLink: vi.fn() }));

import { mySchedule } from "@/modules/schedule/services/schedule";
import { hubLink } from "./links";
import { myNextShiftTool, myUpcomingShiftsTool } from "./scheduling";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function shift(
  clinicDate: string,
  departmentName: string,
  opts: { role?: "DIRECTOR" | "VOLUNTEER" | "SHADOW"; remote?: boolean; closedNote?: string | null; clinicClosed?: boolean } = {}
) {
  return {
    clinicDate: new Date(clinicDate),
    department: { name: departmentName },
    role: opts.role ?? "VOLUNTEER",
    tags: { triage: false, walkin: false, cc: false, remote: opts.remote ?? false, specialty: false },
    clinicClosed: opts.clinicClosed ?? false,
    closedNote: opts.closedNote ?? null,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
  mocked(hubLink).mockImplementation(async (path: string) => `https://hub.test${path}`);
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
    expect(text).toContain("September 12, 2026");
    expect(text).not.toContain("September 11");
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

describe("my_next_shift -- shift details", () => {
  it("names the role and flags a remote shift", async () => {
    mocked(mySchedule).mockResolvedValue({
      terms: [{ isLive: true, shifts: [shift("2026-09-12T00:00:00Z", "Triage", { role: "SHADOW", remote: true })] }],
    });

    const text = await myNextShiftTool.run({ personId: "p1" }, {});

    expect(text).toBe("Your next shift is on Saturday, September 12, 2026: Shadow shift (remote) with Triage.");
  });

  it("says the clinic is closed that day but the shift still stands", async () => {
    mocked(mySchedule).mockResolvedValue({
      terms: [
        {
          isLive: true,
          shifts: [shift("2026-09-12T00:00:00Z", "Triage", { clinicClosed: true, closedNote: "Fall break" })],
        },
      ],
    });

    const text = await myNextShiftTool.run({ personId: "p1" }, {});

    expect(text).toContain("clinic itself is closed that day (Fall break)");
    expect(text).toContain("still scheduled");
  });

  it("points at the schedule page when nothing is upcoming", async () => {
    mocked(mySchedule).mockResolvedValue({ terms: [] });

    const text = await myNextShiftTool.run({ personId: "p1" }, {});

    expect(text).toContain("https://hub.test/schedule");
  });
});

describe("my_upcoming_shifts", () => {
  it("lists every upcoming shift across terms, soonest first, and skips past ones", async () => {
    mocked(mySchedule).mockResolvedValue({
      terms: [
        { isLive: true, shifts: [shift("2026-09-26T00:00:00Z", "Internal Medicine"), shift("2026-09-01T00:00:00Z", "Old")] },
        { isLive: false, shifts: [shift("2026-09-12T00:00:00Z", "Triage")] },
      ],
    });

    const text = await myUpcomingShiftsTool.run({ personId: "p1" }, {});

    expect(text).toMatch(/^You have 2 upcoming shifts\./);
    expect(text.indexOf("Triage")).toBeLessThan(text.indexOf("Internal Medicine"));
    expect(text).not.toContain("Old");
    expect(text).toContain("Full schedule: https://hub.test/schedule");
  });

  it("caps the list and says how many were left out rather than dropping them silently", async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      shift(`2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`, `Dept ${i + 1}`)
    );
    mocked(mySchedule).mockResolvedValue({ terms: [{ isLive: true, shifts: many }] });

    const text = await myUpcomingShiftsTool.run({ personId: "p1" }, {});

    expect(text).toMatch(/^You have 12 upcoming shifts\./);
    expect(text).toContain("Dept 10");
    expect(text).not.toContain("Dept 11");
    expect(text).toContain("(2 more not shown.)");
  });

  it("says so plainly when there are none", async () => {
    mocked(mySchedule).mockResolvedValue({ terms: [] });

    const text = await myUpcomingShiftsTool.run({ personId: "p1" }, {});

    expect(text).toMatch(/no upcoming shifts/i);
  });

  it("takes no input and reads only the caller's schedule", async () => {
    mocked(mySchedule).mockResolvedValue({ terms: [] });

    await myUpcomingShiftsTool.run({ personId: "p1" }, {});

    expect(Object.keys(myUpcomingShiftsTool.inputSchema.shape)).toEqual([]);
    expect(mocked(mySchedule)).toHaveBeenCalledWith("p1");
  });
});
