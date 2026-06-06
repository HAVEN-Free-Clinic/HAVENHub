import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { recordAudit } from "./audit";

describe("recordAudit", () => {
  beforeEach(resetDb);

  it("persists an audit row with before/after snapshots", async () => {
    await recordAudit({
      actorPersonId: "person-1",
      action: "person.update",
      entityType: "Person",
      entityId: "person-2",
      before: { phone: "111" },
      after: { phone: "222" },
      ip: "127.0.0.1",
    });
    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("person.update");
    expect(rows[0].before).toEqual({ phone: "111" });
  });

  it("never throws: audit failure must not break the mutation it records", async () => {
    // entityType deliberately missing → Prisma rejects; recordAudit swallows and logs.
    await expect(
      recordAudit({ action: "x", entityType: undefined as unknown as string })
    ).resolves.toBeUndefined();
  });
});
