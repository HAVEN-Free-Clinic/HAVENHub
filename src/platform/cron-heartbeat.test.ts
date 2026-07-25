import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getCronHealth, recordCronHeartbeat, CRON_JOBS } from "./cron-heartbeat";

beforeEach(async () => { await resetDb(); });

const JOB = "schedule-reminders";
const maxStale = CRON_JOBS.find((j) => j.id === JOB)!.maxStaleMs;

describe("getCronHealth", () => {
  it("does not flag a never-run job during the grace window right after first observation (#127)", async () => {
    const t0 = new Date("2026-07-01T00:00:00Z");
    const health = await getCronHealth(t0);
    const j = health.find((h) => h.id === JOB)!;
    expect(j.lastSuccessAt).toBeNull();
    expect(j.neverRun).toBe(true);
    expect(j.stale).toBe(false); // firstSeenAt just stamped -> within its grace window
  });

  it("flags a never-run job once it has been silent past its window since first observed (#127)", async () => {
    const t0 = new Date("2026-07-01T00:00:00Z");
    await getCronHealth(t0); // stamps firstSeenAt = t0
    const later = new Date(t0.getTime() + maxStale + 1);
    const health = await getCronHealth(later);
    const j = health.find((h) => h.id === JOB)!;
    // A job that was never provisioned (or whose secret is wrong so every call 401s)
    // never writes a heartbeat; it must be flagged once past its window, not hidden.
    expect(j.lastSuccessAt).toBeNull();
    expect(j.neverRun).toBe(true);
    expect(j.stale).toBe(true);
  });

  it("keeps the firstSeenAt anchor stable across calls (grace is measured from first observation, not each render)", async () => {
    const t0 = new Date("2026-07-01T00:00:00Z");
    await getCronHealth(t0);
    // A second view a moment later must NOT reset the anchor to the new now.
    await getCronHealth(new Date(t0.getTime() + 60_000));
    const later = new Date(t0.getTime() + maxStale + 1);
    const j = (await getCronHealth(later)).find((h) => h.id === JOB)!;
    expect(j.stale).toBe(true);
  });

  it("a job that has succeeded recently is healthy", async () => {
    await recordCronHeartbeat(JOB);
    const j = (await getCronHealth()).find((h) => h.id === JOB)!;
    expect(j.lastSuccessAt).not.toBeNull();
    expect(j.neverRun).toBe(false);
    expect(j.stale).toBe(false);
  });

  it("a job that succeeded but then stopped is stale (the ran-then-stopped case)", async () => {
    const old = new Date(Date.now() - maxStale - 60_000);
    await prisma.setting.create({ data: { key: `cron.lastSuccess.${JOB}`, value: { at: old.toISOString() } } });
    const j = (await getCronHealth()).find((h) => h.id === JOB)!;
    expect(j.neverRun).toBe(false);
    expect(j.stale).toBe(true);
  });
});
