import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { listPendingDeactivations } from "./itcm";

describe("listPendingDeactivations", () => {
  beforeEach(resetDb);

  it("returns only people with an open PENDING DEACTIVATE request", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor" } });
    const a = await prisma.person.create({ data: { name: "Alice", epicId: "EA", status: "OFFBOARDED" } });
    const b = await prisma.person.create({ data: { name: "Bob", epicId: "EB", status: "OFFBOARDED" } });
    const c = await prisma.person.create({ data: { name: "Carol", epicId: "EC", status: "ACTIVE" } });

    await prisma.epicRequest.create({ data: { personId: a.id, kind: "DEACTIVATE", status: "PENDING", requestedById: actor.id } });
    await prisma.epicRequest.create({ data: { personId: b.id, kind: "DEACTIVATE", status: "COMPLETED", requestedById: actor.id } });
    await prisma.epicRequest.create({ data: { personId: c.id, kind: "NEW", status: "PENDING", requestedById: actor.id } });

    const rows = await listPendingDeactivations();
    expect(rows.map((r) => r.name)).toEqual(["Alice"]);
    expect(rows[0].epicId).toBe("EA");
  });
});
