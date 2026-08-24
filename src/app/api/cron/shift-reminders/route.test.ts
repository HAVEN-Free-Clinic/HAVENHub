import { describe, expect, it, vi, afterEach } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/cron/shift-reminders", () => {
  it("rejects an unauthorized request with 401 and does not run the job", async () => {
    vi.stubEnv("CRON_SECRET", "sekret");
    const job = await import("@/platform/email/shift-reminders");
    const spy = vi.spyOn(job, "runShiftReminders").mockResolvedValue({ remindersSent: 0, skipped: 0, roleRemindersSent: 0, roleRemindersSkipped: 0 });
    const { GET } = await import("./route");

    const res = await GET(new Request("https://x/api/cron/shift-reminders")); // no Authorization header
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("runs the job when the bearer token matches", async () => {
    vi.stubEnv("CRON_SECRET", "sekret");
    const job = await import("@/platform/email/shift-reminders");
    const spy = vi.spyOn(job, "runShiftReminders").mockResolvedValue({ remindersSent: 3, skipped: 1, roleRemindersSent: 2, roleRemindersSkipped: 0 });
    const { GET } = await import("./route");

    const res = await GET(
      new Request("https://x/api/cron/shift-reminders", { headers: { Authorization: "Bearer sekret" } }),
    );
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({
      ok: true,
      remindersSent: 3,
      skipped: 1,
      roleRemindersSent: 2,
      roleRemindersSkipped: 0,
    });
  });
});
