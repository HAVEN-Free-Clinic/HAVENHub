/**
 * TDD tests for attachEpicRequests: attaching 1..n Epic requests (any active
 * people, any category, non-terminal ticket) to one IT Support ticket.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createTechRequest,
  SupportForbiddenError,
  SupportNotFoundError,
  SupportStateError,
} from "./tech-request";
import { cancelOwnRequest } from "./manage";
import { attachEpicRequests } from "./epic-link";

async function createPerson(
  name: string,
  opts: { epicId?: string; status?: "ACTIVE" | "OFFBOARDED" } = {}
) {
  return prisma.person.create({
    data: { name, epicId: opts.epicId ?? null, status: opts.status ?? "ACTIVE" },
  });
}
async function grantManage(personId: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${personId}`,
      isSystem: false,
      grants: { create: [{ permission: "support.manage_requests" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}
async function epicTicket(requesterId: string, category: "EPIC" | "GENERAL_IT" = "EPIC") {
  return createTechRequest(requesterId, { category, subject: "Need Epic", description: "d" });
}

beforeEach(resetDb);

describe("attachEpicRequests", () => {
  it("attaches one NEW request for the requester and moves the ticket to IN_PROGRESS", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    const t = await epicTicket(owner.id);

    const created = await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] });

    expect(created).toHaveLength(1);
    expect(created[0].kind).toBe("NEW");
    expect(created[0].personId).toBe(owner.id);
    expect(created[0].techRequestId).toBe(t.id);
    expect(created[0].status).toBe("PENDING");
    const linked = await prisma.techRequest.findUniqueOrThrow({ where: { id: t.id } });
    expect(linked.status).toBe("IN_PROGRESS");
  });

  it("attaches a bulk NEW request for several other people", async () => {
    const director = await createPerson("Director");
    const a = await createPerson("Vol A");
    const b = await createPerson("Vol B");
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    const t = await epicTicket(director.id);

    const created = await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [a.id, b.id] });

    expect(created.map((r) => r.personId).sort()).toEqual([a.id, b.id].sort());
    const count = await prisma.epicRequest.count({ where: { techRequestId: t.id } });
    expect(count).toBe(2);
  });

  it("attaches to a non-EPIC category ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    const t = await epicTicket(owner.id, "GENERAL_IT");

    const created = await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] });
    expect(created).toHaveLength(1);
  });

  it("allows a second request once the first is terminal (follow-up)", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    const t = await epicTicket(owner.id);
    const [first] = await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] });
    // Simulate the first reaching a terminal state so the person has no open request.
    await prisma.epicRequest.update({ where: { id: first.id }, data: { status: "CANCELLED" } });

    const [second] = await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] });
    expect(second.id).not.toBe(first.id);
    const total = await prisma.epicRequest.count({ where: { techRequestId: t.id } });
    expect(total).toBe(2);
  });

  it("rejects the whole batch (all-or-nothing) when one person is invalid", async () => {
    const good = await createPerson("Good");
    const bad = await createPerson("Bad", { status: "OFFBOARDED" });
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    const t = await epicTicket(good.id);

    await expect(
      attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [good.id, bad.id] })
    ).rejects.toThrow(SupportStateError);
    const count = await prisma.epicRequest.count();
    expect(count).toBe(0);
  });

  it("rejects a duplicate open request for a person", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    const t = await epicTicket(owner.id);
    await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] });

    await expect(
      attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] })
    ).rejects.toThrow(SupportStateError);
  });

  it("rejects a terminal (cancelled) ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    const t = await epicTicket(owner.id);
    await cancelOwnRequest(owner.id, t.id);

    await expect(
      attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] })
    ).rejects.toThrow(SupportStateError);
    expect(await prisma.epicRequest.count()).toBe(0);
  });

  it("rejects a non-manager", async () => {
    const owner = await createPerson("Owner");
    const t = await epicTicket(owner.id);
    await expect(
      attachEpicRequests(owner.id, t.id, { kind: "NEW", personIds: [owner.id] })
    ).rejects.toThrow(SupportForbiddenError);
  });

  it("rejects a missing ticket", async () => {
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    await expect(
      attachEpicRequests(mgr.id, "nope", { kind: "NEW", personIds: [mgr.id] })
    ).rejects.toThrow(SupportNotFoundError);
  });

  it("rejects DEACTIVATE and empty personIds", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    const t = await epicTicket(owner.id);
    await expect(
      attachEpicRequests(mgr.id, t.id, { kind: "DEACTIVATE" as never, personIds: [owner.id] })
    ).rejects.toThrow(SupportStateError);
    await expect(
      attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [] })
    ).rejects.toThrow(SupportStateError);
  });
});
