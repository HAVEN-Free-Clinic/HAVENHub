import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { claimReminderDispatch } from "./reminder-dispatch";

beforeEach(resetDb);

describe("claimReminderDispatch", () => {
  it("returns true for the first claim and false for a duplicate (kind, personId, periodKey)", async () => {
    expect(await claimReminderDispatch("shift-reminder", "p1", "2026-07-18")).toBe(true);
    // A second run for the same key loses the atomic claim, so it does not re-send.
    expect(await claimReminderDispatch("shift-reminder", "p1", "2026-07-18")).toBe(false);
  });

  it("distinguishes different kinds, people, and periods", async () => {
    expect(await claimReminderDispatch("shift-reminder", "p1", "2026-07-18")).toBe(true);
    expect(await claimReminderDispatch("schedule-request-reminder", "p1", "2026-07-18")).toBe(true);
    expect(await claimReminderDispatch("shift-reminder", "p2", "2026-07-18")).toBe(true);
    expect(await claimReminderDispatch("shift-reminder", "p1", "2026-07-25")).toBe(true);
  });
});
