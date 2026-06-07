/**
 * Sync service tests (TDD).
 *
 * Tests cover:
 * - syncOverview: returns correct shape with worker.ok true/false depending on
 *   heartbeat freshness, outbox pending/failed/sentLast24h counts, failures
 *   array (FAILED rows, latest 20), drift array (mirror.drift_corrected audit rows, latest 20)
 * - retryFailed: flips FAILED rows to PENDING with attempts=0 / lastError=null;
 *   audits sync.retry_failed with { count }; returns the count
 * - retryFailed with zero FAILED rows: returns 0 and writes NO audit entry
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { syncOverview, retryFailed } from "./sync";
import { config } from "@/platform/config";

const ACTOR = "actor-person-id";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedOutbox(
  status: "PENDING" | "SENT" | "FAILED",
  processedAt?: Date,
  attempts = 0,
  lastError?: string
) {
  return prisma.outbox.create({
    data: {
      entityType: "Person",
      entityId: `entity-${Date.now()}-${Math.random()}`,
      operation: "upsert",
      changedFields: ["name"],
      status,
      attempts,
      lastError: lastError ?? null,
      processedAt: processedAt ?? null,
    },
  });
}

async function seedHeartbeat(beatAt: Date) {
  return prisma.workerHeartbeat.upsert({
    where: { id: "mirror-worker" },
    create: { id: "mirror-worker", beatAt },
    update: { beatAt },
  });
}

async function seedDriftAudit(entityId: string, after: Record<string, unknown>) {
  return prisma.auditLog.create({
    data: {
      action: "mirror.drift_corrected",
      entityType: "Person",
      entityId,
      after: after as import("@prisma/client").Prisma.InputJsonValue,
    },
  });
}

// ---------------------------------------------------------------------------
// syncOverview
// ---------------------------------------------------------------------------

describe("syncOverview", () => {
  beforeEach(resetDb);

  it("returns the correct shape with no data", async () => {
    const overview = await syncOverview();

    expect(overview).toMatchObject({
      mirrorEnabled: expect.any(Boolean),
      targetBaseId: expect.toBeOneOf([null, expect.any(String)]),
      worker: { ok: false, beatAt: null },
      outbox: { pending: 0, failed: 0, sentLast24h: 0 },
      failures: [],
      drift: [],
    });
  });

  it("reports worker.ok=true when heartbeat is fresh (within 90s)", async () => {
    const now = new Date();
    // 30 seconds ago -- fresh
    await seedHeartbeat(new Date(now.getTime() - 30_000));

    const overview = await syncOverview();
    expect(overview.worker.ok).toBe(true);
    expect(overview.worker.beatAt).toBeInstanceOf(Date);
  });

  it("reports worker.ok=false when heartbeat is stale (older than 90s)", async () => {
    const now = new Date();
    // 120 seconds ago -- stale
    await seedHeartbeat(new Date(now.getTime() - 120_000));

    const overview = await syncOverview();
    expect(overview.worker.ok).toBe(false);
    expect(overview.worker.beatAt).toBeInstanceOf(Date);
  });

  it("reports worker.ok=false when no heartbeat row exists", async () => {
    const overview = await syncOverview();
    expect(overview.worker.ok).toBe(false);
    expect(overview.worker.beatAt).toBeNull();
  });

  it("counts pending and failed outbox rows correctly", async () => {
    await seedOutbox("PENDING");
    await seedOutbox("PENDING");
    await seedOutbox("FAILED");

    const overview = await syncOverview();
    expect(overview.outbox.pending).toBe(2);
    expect(overview.outbox.failed).toBe(1);
  });

  it("counts sentLast24h: only SENT rows with processedAt >= now-24h", async () => {
    const now = new Date();
    const within24h = new Date(now.getTime() - 12 * 60 * 60 * 1000); // 12h ago
    const outside24h = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25h ago

    await seedOutbox("SENT", within24h);
    await seedOutbox("SENT", within24h);
    await seedOutbox("SENT", outside24h); // should not count
    await seedOutbox("PENDING");           // should not count

    const overview = await syncOverview();
    expect(overview.outbox.sentLast24h).toBe(2);
  });

  it("returns FAILED rows in failures array (latest 20, desc)", async () => {
    // Create 22 FAILED rows -- only 20 should appear
    for (let i = 0; i < 22; i++) {
      await seedOutbox("FAILED", undefined, i, `error ${i}`);
    }

    const overview = await syncOverview();
    expect(overview.failures).toHaveLength(20);
    // All should be FAILED
    for (const row of overview.failures) {
      expect(row.status).toBe("FAILED");
    }
    // Newest first: the row with the highest attempts (21) should be near top
    // (since attempts correlates with insertion order in our seed)
    expect(overview.failures[0].createdAt >= overview.failures[1].createdAt).toBe(true);
  });

  it("returns mirror.drift_corrected audit rows in drift array (latest 20, desc)", async () => {
    for (let i = 0; i < 22; i++) {
      await seedDriftAudit(`entity-${i}`, { name: `new ${i}`, email: `e${i}@test.com` });
    }

    const overview = await syncOverview();
    expect(overview.drift).toHaveLength(20);
    for (const row of overview.drift) {
      expect(row.action).toBe("mirror.drift_corrected");
    }
    // Newest first
    expect(overview.drift[0].createdAt >= overview.drift[1].createdAt).toBe(true);
  });

  it("reflects config.AIRTABLE_MIRROR_ENABLED and config.AIRTABLE_MIRROR_BASE_ID", async () => {
    const overview = await syncOverview();
    expect(overview.mirrorEnabled).toBe(config.AIRTABLE_MIRROR_ENABLED);
    expect(overview.targetBaseId).toBe(config.AIRTABLE_MIRROR_BASE_ID ?? null);
  });
});

// ---------------------------------------------------------------------------
// retryFailed
// ---------------------------------------------------------------------------

describe("retryFailed", () => {
  beforeEach(resetDb);

  it("flips FAILED rows to PENDING with attempts=0 and lastError=null", async () => {
    await seedOutbox("FAILED", undefined, 3, "network timeout");
    await seedOutbox("FAILED", undefined, 5, "not found");
    await seedOutbox("PENDING"); // should not be touched

    const count = await retryFailed(ACTOR);
    expect(count).toBe(2);

    const failed = await prisma.outbox.findMany({ where: { status: "FAILED" } });
    expect(failed).toHaveLength(0);

    const pending = await prisma.outbox.findMany({ where: { status: "PENDING" } });
    expect(pending).toHaveLength(3);
    // All retried rows have attempts=0 and no lastError
    const retried = pending.filter((r) => r.attempts === 0);
    expect(retried).toHaveLength(3); // the pre-existing PENDING + 2 retried
    for (const r of retried) {
      expect(r.lastError).toBeNull();
    }
  });

  it("audits sync.retry_failed with { count } when rows are retried", async () => {
    await seedOutbox("FAILED", undefined, 2, "some error");

    const count = await retryFailed(ACTOR);
    expect(count).toBe(1);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "sync.retry_failed" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorPersonId).toBe(ACTOR);
    expect(audit?.after).toMatchObject({ count: 1 });
  });

  it("returns 0 and writes NO audit entry when there are no FAILED rows", async () => {
    await seedOutbox("PENDING");

    const count = await retryFailed(ACTOR);
    expect(count).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "sync.retry_failed" },
    });
    expect(audit).toBeNull();
  });

  it("does not touch PENDING or SENT rows", async () => {
    const pending = await seedOutbox("PENDING");
    const sent = await seedOutbox("SENT", new Date(), 1);

    await retryFailed(ACTOR);

    const pendingAfter = await prisma.outbox.findUnique({ where: { id: pending.id } });
    expect(pendingAfter?.status).toBe("PENDING");

    const sentAfter = await prisma.outbox.findUnique({ where: { id: sent.id } });
    expect(sentAfter?.status).toBe("SENT");
  });
});
