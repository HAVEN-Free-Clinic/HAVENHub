import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { listPendingDeactivations, reconcileDeactivationRequests } from "./itcm";

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

describe("reconcileDeactivationRequests", () => {
  beforeEach(resetDb);

  it("attaches an existing pending DEACTIVATE to the ticket without duplicating, and creates one when missing", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor" } });
    const withReq = await prisma.person.create({ data: { name: "HasReq", epicId: "E1", status: "OFFBOARDED" } });
    const withoutReq = await prisma.person.create({ data: { name: "NoReq", epicId: "E2", status: "OFFBOARDED" } });
    const existing = await prisma.epicRequest.create({
      data: { personId: withReq.id, kind: "DEACTIVATE", status: "PENDING", requestedById: actor.id },
    });
    const ticket = await prisma.ynhhTicket.create({ data: { submittedById: actor.id, status: "OPEN" } });

    await reconcileDeactivationRequests(actor.id, [withReq.id, withoutReq.id], ticket.id);

    const reused = await prisma.epicRequest.findUnique({ where: { id: existing.id } });
    expect(reused?.status).toBe("SUBMITTED");
    expect(reused?.ticketId).toBe(ticket.id);

    const forWithReq = await prisma.epicRequest.findMany({ where: { personId: withReq.id, kind: "DEACTIVATE" } });
    expect(forWithReq).toHaveLength(1); // no duplicate

    const created = await prisma.epicRequest.findMany({ where: { personId: withoutReq.id, kind: "DEACTIVATE" } });
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe("SUBMITTED");
    expect(created[0].ticketId).toBe(ticket.id);
  });

  it("reuses an already-SUBMITTED open DEACTIVATE, re-pointing it at the new ticket without duplicating", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor" } });
    const person = await prisma.person.create({ data: { name: "AlreadySubmitted", epicId: "E3", status: "OFFBOARDED" } });
    const oldTicket = await prisma.ynhhTicket.create({ data: { submittedById: actor.id, status: "OPEN" } });
    const existing = await prisma.epicRequest.create({
      data: { personId: person.id, kind: "DEACTIVATE", status: "SUBMITTED", ticketId: oldTicket.id, requestedById: actor.id },
    });
    const newTicket = await prisma.ynhhTicket.create({ data: { submittedById: actor.id, status: "OPEN" } });

    await reconcileDeactivationRequests(actor.id, [person.id], newTicket.id);

    const reused = await prisma.epicRequest.findUnique({ where: { id: existing.id } });
    expect(reused?.status).toBe("SUBMITTED");
    expect(reused?.ticketId).toBe(newTicket.id);

    const all = await prisma.epicRequest.findMany({ where: { personId: person.id, kind: "DEACTIVATE" } });
    expect(all).toHaveLength(1); // no duplicate
  });
});
