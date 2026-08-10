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

  it("never throws on the singleton path: audit failure must not break the mutation it records", async () => {
    // entityType deliberately missing -> Prisma rejects; recordAudit swallows and logs.
    await expect(
      recordAudit({ action: "x", entityType: undefined as unknown as string })
    ).resolves.toBeUndefined();
  });

  it("still swallows when the singleton is passed explicitly as the client", async () => {
    await expect(
      recordAudit({ action: "x", entityType: undefined as unknown as string }, prisma)
    ).resolves.toBeUndefined();
  });

  it("propagates a failing insert when recording inside a transaction, rolling back other writes made earlier in that same transaction", async () => {
    // entityType deliberately missing -> Prisma rejects. On a transaction client
    // the failure must NOT be swallowed: swallowing it here would either break
    // any later statement in the same transaction with a "current transaction
    // is aborted" error, or, if this were the last statement, let Postgres
    // silently turn the COMMIT into a ROLLBACK while the caller believes it
    // succeeded. Rethrowing lets $transaction roll back honestly instead.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.person.create({ data: { name: "Rolled Back" } });
        await recordAudit({ action: "x", entityType: undefined as unknown as string }, tx);
      })
    ).rejects.toThrow();

    const rolledBackPerson = await prisma.person.findFirst({ where: { name: "Rolled Back" } });
    expect(rolledBackPerson).toBeNull();
    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(0);
  });
});
