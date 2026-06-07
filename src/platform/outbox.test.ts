import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { enqueueMirror, outboxStats } from "./outbox";

describe("outbox", () => {
  beforeEach(resetDb);

  it("enqueues inside the caller's transaction (rollback removes the row)", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueMirror(tx, { entityType: "Person", entityId: "p1", changedFields: ["name"] });
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    expect((await outboxStats()).pending).toBe(0);

    await prisma.$transaction(async (tx) => {
      await enqueueMirror(tx, { entityType: "Person", entityId: "p1", changedFields: ["name"] });
    });
    expect((await outboxStats()).pending).toBe(1);
  });

  it("reports pending and failed counts", async () => {
    await prisma.outbox.create({
      data: { entityType: "Person", entityId: "p2", operation: "upsert", changedFields: [], status: "FAILED" },
    });
    const stats = await outboxStats();
    expect(stats.failed).toBe(1);
  });
});
