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

// ---------------------------------------------------------------------------
// Registry completeness (audit 14, finding 4)
//
// attending-reminders stamped a heartbeat under an id CRON_JOBS did not contain,
// so getCronHealth -- which maps over CRON_JOBS -- never read the row back, and
// the admin panel could not flag that job however long it stayed dead. Its
// recipients have no Person row and no inbox, and Faculty Relations used to send
// that email by hand, so nothing else accumulates to reveal the silence.
//
// Nothing caught it: every test above picks a single JOB *out of* CRON_JOBS, so
// they can only ever exercise ids that are already registered. This walks the
// route files instead, which are the only source of truth for what gets stamped.
// ---------------------------------------------------------------------------

/** Every id passed to recordCronHeartbeat across the cron route files. */
async function stampedCronIds(): Promise<string[]> {
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  const cronDir = join(process.cwd(), "src/app/api/cron");
  const ids: string[] = [];
  for (const entry of readdirSync(cronDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const routeFile = join(cronDir, entry.name, "route.ts");
    if (!existsSync(routeFile)) continue;
    for (const m of readFileSync(routeFile, "utf8").matchAll(
      /recordCronHeartbeat\(\s*["'`]([^"'`]+)["'`]\s*\)/g
    )) {
      ids.push(m[1]);
    }
  }
  return ids;
}

describe("CRON_JOBS registry", () => {
  it("contains every id that a cron route stamps a heartbeat for", async () => {
    const stamped = await stampedCronIds();
    // If this finds nothing, the walk is broken rather than the registry.
    expect(stamped.length).toBeGreaterThan(5);

    const registered = new Set(CRON_JOBS.map((j) => j.id));
    expect(stamped.filter((id) => !registered.has(id))).toEqual([]);
  });

  it("registers no id that no route stamps (a job that could never report)", async () => {
    const stamped = new Set(await stampedCronIds());
    expect(CRON_JOBS.map((j) => j.id).filter((id) => !stamped.has(id))).toEqual([]);
  });
});
