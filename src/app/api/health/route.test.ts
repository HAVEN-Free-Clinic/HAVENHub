import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("reports ok with a reachable database", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.db).toBe(true);
  });
});

describe("GET /api/health - worker heartbeat and outbox", () => {
  beforeEach(resetDb);

  it("reports worker.ok false and status 200 when no heartbeat row exists", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.db).toBe(true);
    expect(body.worker.ok).toBe(false);
  });

  it("reports worker.ok true for a fresh heartbeat and includes numeric outbox counts", async () => {
    await prisma.workerHeartbeat.upsert({
      where: { id: "mirror-worker" },
      update: { beatAt: new Date() },
      create: { id: "mirror-worker", beatAt: new Date() },
    });
    await prisma.outbox.create({
      data: {
        entityType: "Person",
        entityId: "test-person-1",
        operation: "upsert",
        changedFields: [],
        status: "FAILED",
      },
    });
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.worker.ok).toBe(true);
    expect(typeof body.outbox.pending).toBe("number");
    expect(typeof body.outbox.failed).toBe("number");
    expect(body.outbox.failed).toBe(1);
  });

  it("reports worker.ok false for a stale heartbeat (5 minutes ago)", async () => {
    const staleDate = new Date(Date.now() - 5 * 60 * 1000);
    await prisma.workerHeartbeat.upsert({
      where: { id: "mirror-worker" },
      update: { beatAt: staleDate },
      create: { id: "mirror-worker", beatAt: staleDate },
    });
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.worker.ok).toBe(false);
  });
});
