/**
 * TDD tests for attachEpicRequests: attaching 1..n Epic requests (any active
 * people, any category, non-terminal ticket) to one IT Support ticket.
 *
 * Also covers linkEpicRequestToTicket's YNHH handoff (epic.ts): a request
 * already SUBMITTED to YNHH before it is linked to a ticket must fire
 * onEpicSubmitted so the newly-linked ticket learns it is waiting on YNHH.
 * That function lives in epic.ts, but its handoff behaviour is exercised
 * here alongside attachEpicRequests's own Intercom-sync fix, since both are
 * "a Hub status change must not bypass setStatus / onEpicSubmitted" bugs in
 * the same Epic-attach pipeline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createTechRequest,
  SupportForbiddenError,
  SupportNotFoundError,
  SupportStateError,
} from "./tech-request";

/**
 * setStatus wrapped in vi.fn DELEGATING to the real implementation, exactly
 * like epic.test.ts wraps updatePersonFields: every test here behaves as
 * before, and the "status advance fails" test below uses
 * mockRejectedValueOnce to stage a single failed setStatus call, which no
 * amount of real database setup can produce on demand.
 */
vi.mock("./manage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manage")>();
  return { ...actual, setStatus: vi.fn(actual.setStatus) };
});

import { cancelOwnRequest, setStatus } from "./manage";
import { attachEpicRequests } from "./epic-link";
import { linkEpicRequestToTicket } from "./epic";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

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
async function ynhhTicket(submittedById: string) {
  return prisma.ynhhTicket.create({ data: { status: "OPEN", submittedById } });
}

beforeEach(resetDb);
afterEach(() => {
  mocked(setStatus).mockClear();
});

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

  it("advances a SUBMITTED ticket to IN_PROGRESS through setStatus, not a raw write", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    const t = await epicTicket(owner.id); // fresh ticket: TechRequest defaults to SUBMITTED

    await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] });

    const linked = await prisma.techRequest.findUniqueOrThrow({ where: { id: t.id } });
    expect(linked.status).toBe("IN_PROGRESS");
    expect(setStatus).toHaveBeenCalledWith(mgr.id, t.id, "IN_PROGRESS");
    // setStatus, unlike the old raw column write, leaves its own status-change
    // audit trail.
    const statusAudit = await prisma.auditLog.findFirst({
      where: { action: "support.status_change", entityId: t.id },
    });
    expect(statusAudit).not.toBeNull();
  });

  it("leaves a ticket that is not SUBMITTED alone (no setStatus call)", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    const t = await epicTicket(owner.id);
    await setStatus(mgr.id, t.id, "IN_PROGRESS"); // already past SUBMITTED
    mocked(setStatus).mockClear();

    await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] });

    const linked = await prisma.techRequest.findUniqueOrThrow({ where: { id: t.id } });
    expect(linked.status).toBe("IN_PROGRESS");
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("still attaches the requests, and keeps them, when the status advance fails", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    const t = await epicTicket(owner.id);
    mocked(setStatus).mockRejectedValueOnce(new Error("Intercom unreachable"));

    const created = await attachEpicRequests(mgr.id, t.id, { kind: "NEW", personIds: [owner.id] });

    expect(created).toHaveLength(1);
    expect(await prisma.epicRequest.count({ where: { techRequestId: t.id } })).toBe(1);

    // setStatus threw before its own write landed, so the ticket never
    // actually advanced -- but attachEpicRequests did not throw to the caller.
    const linked = await prisma.techRequest.findUniqueOrThrow({ where: { id: t.id } });
    expect(linked.status).toBe("SUBMITTED");

    const failureAudit = await prisma.auditLog.findFirst({
      where: { action: "support.epic_attach_status_advance_failed", entityId: t.id },
    });
    expect(failureAudit).not.toBeNull();
    const after = failureAudit?.after as Record<string, unknown>;
    expect(after.error).toContain("Intercom unreachable");

    // The attach itself is still audited normally.
    const attachAudit = await prisma.auditLog.findFirst({
      where: { action: "support.epic_attach", entityId: t.id },
    });
    expect(attachAudit).not.toBeNull();
  });
});

describe("linkEpicRequestToTicket fires the YNHH handoff", () => {
  it("moves the newly-linked ticket to AWAITING_YNHH when the request is already SUBMITTED to YNHH", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    const t = await epicTicket(owner.id);
    // Off the default SUBMITTED so the AWAITING_YNHH transition is observable.
    await setStatus(mgr.id, t.id, "IN_PROGRESS");
    const yt = await ynhhTicket(mgr.id);
    const req = await prisma.epicRequest.create({
      data: { personId: owner.id, kind: "NEW", status: "SUBMITTED", requestedById: mgr.id, ticketId: yt.id },
    });

    await linkEpicRequestToTicket(mgr.id, req.id, t.number);

    const updated = await prisma.techRequest.findUniqueOrThrow({ where: { id: t.id } });
    expect(updated.status).toBe("AWAITING_YNHH");
  });

  it("does not fire the handoff for a request never submitted to YNHH (PENDING)", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    const t = await epicTicket(owner.id);
    await setStatus(mgr.id, t.id, "IN_PROGRESS");
    const req = await prisma.epicRequest.create({
      data: { personId: owner.id, kind: "NEW", status: "PENDING", requestedById: mgr.id },
    });

    await linkEpicRequestToTicket(mgr.id, req.id, t.number);

    const updated = await prisma.techRequest.findUniqueOrThrow({ where: { id: t.id } });
    expect(updated.status).toBe("IN_PROGRESS");
  });

  it("does not fire the handoff for a request already resolved (COMPLETED)", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantManage(mgr.id);
    const t = await epicTicket(owner.id);
    await setStatus(mgr.id, t.id, "IN_PROGRESS");
    const yt = await ynhhTicket(mgr.id);
    const req = await prisma.epicRequest.create({
      data: {
        personId: owner.id,
        kind: "NEW",
        status: "COMPLETED",
        requestedById: mgr.id,
        ticketId: yt.id,
        completedAt: new Date(),
      },
    });

    await linkEpicRequestToTicket(mgr.id, req.id, t.number);

    const updated = await prisma.techRequest.findUniqueOrThrow({ where: { id: t.id } });
    expect(updated.status).toBe("IN_PROGRESS");
  });
});
