/**
 * TDD tests for the support epic request service.
 *
 * createEpicRequest(actorPersonId, input):
 *   - Self-create NEW happy path; audit row with kind in after.
 *   - Non-manager cannot create for someone else (EpicForbiddenError).
 *   - Manager (support.manage_requests) creates for anyone.
 *   - Duplicate-open rejected when PENDING request exists (EpicStateError).
 *   - Duplicate-open rejected when SUBMITTED request exists (EpicStateError).
 *   - NEW with existing epicId on person rejected (EpicStateError).
 *   - MODIFY without epicId on person rejected (EpicStateError).
 *   - OFFBOARDED person rejected (EpicStateError).
 *   - Person not found -> EpicNotFoundError.
 *
 * createTicket(actorPersonId, input):
 *   - Happy path: ticket created, requests moved to SUBMITTED.
 *   - Non-PENDING id in requestIds -> EpicStateError.
 *   - Unknown id in requestIds -> EpicStateError, no ticket created, valid request stays PENDING.
 *   - No permission -> EpicForbiddenError.
 *   - Concurrent double-submit: only one caller claims the request; the loser
 *     throws and creates no ticket (atomic PENDING claim).
 *
 * setTicketServiceRequestNumber:
 *   - Sets SR number; audits ticket_sr.
 *
 * completeRequest(actorPersonId, requestId, epicId?):
 *   - NEW: writes Person.epicId via updatePersonFields.
 *   - RENEW: leaves person untouched even when epicId passed.
 *   - NEW without epicId -> EpicStateError.
 *   - COMPLETED/CANCELLED status -> EpicStateError.
 *   - Not found -> EpicNotFoundError.
 *
 * sendEpicEmail(actorPersonId, requestId, template):
 *   - Queues EmailLog row with right template/to/personId/triggeredById.
 *   - No contactEmail -> EpicStateError.
 *   - No permission -> EpicForbiddenError.
 *
 * cancelEpicRequest(actorPersonId, requestId):
 *   - Cancels a PENDING request; audits epic.cancel.
 *   - Non-PENDING request -> EpicStateError.
 *   - No permission -> EpicForbiddenError.
 *   - Not found -> EpicNotFoundError.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as channel from "@/platform/notifications/channel";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createEpicRequest,
  createTicket,
  setTicketServiceRequestNumber,
  completeRequest,
  sendEpicEmail,
  cancelEpicRequest,
  EpicForbiddenError,
  EpicNotFoundError,
  EpicStateError,
} from "./epic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createPerson(
  name: string,
  opts: { netId?: string; contactEmail?: string; epicId?: string; status?: "ACTIVE" | "OFFBOARDED" } = {}
) {
  return prisma.person.create({
    data: {
      name,
      netId: opts.netId ?? null,
      contactEmail: opts.contactEmail ?? null,
      epicId: opts.epicId ?? null,
      status: opts.status ?? "ACTIVE",
    },
  });
}

async function createTerm(status: "ACTIVE" | "ARCHIVED" | "PLANNING" = "ACTIVE", code = "SU26") {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-09-26"),
      status,
    },
  });
}

async function createDepartment(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Dept` },
  });
}

async function createMembership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "VOLUNTEER" | "DIRECTOR",
  status: "ACTIVE" | "REMOVED" = "ACTIVE"
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status },
  });
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${Date.now()}-${Math.random()}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(resetDb);

describe("createEpicRequest", () => {
  it("self-create NEW happy path; audit row with kind in after", async () => {
    const person = await createPerson("Alice", { netId: "aaa001" });

    const req = await createEpicRequest(person.id, {
      personId: person.id,
      kind: "NEW",
    });

    expect(req.personId).toBe(person.id);
    expect(req.kind).toBe("NEW");
    expect(req.status).toBe("PENDING");
    expect(req.requestedById).toBe(person.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "epic.request", entityId: req.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorPersonId).toBe(person.id);
    const after = audit?.after as Record<string, unknown>;
    expect(after.kind).toBe("NEW");
  });

  it("non-manager cannot create for someone else (EpicForbiddenError)", async () => {
    const actor = await createPerson("Actor", { netId: "act001" });
    const target = await createPerson("Target", { netId: "tgt001" });

    await expect(
      createEpicRequest(actor.id, { personId: target.id, kind: "NEW" })
    ).rejects.toBeInstanceOf(EpicForbiddenError);
  });

  it("manager (support.manage_requests) creates for anyone", async () => {
    const manager = await createPerson("Manager", { netId: "mgr001" });
    const target = await createPerson("Target", { netId: "tgt001" });
    await grantPermission(manager.id, "support.manage_requests");

    const req = await createEpicRequest(manager.id, { personId: target.id, kind: "NEW" });
    expect(req.personId).toBe(target.id);
    expect(req.requestedById).toBe(manager.id);
  });

  it("duplicate-open rejected when PENDING request exists (EpicStateError)", async () => {
    const person = await createPerson("Alice", { netId: "aaa001" });
    await createEpicRequest(person.id, { personId: person.id, kind: "NEW" });

    await expect(
      createEpicRequest(person.id, { personId: person.id, kind: "NEW" })
    ).rejects.toBeInstanceOf(EpicStateError);
  });

  it("duplicate-open rejected when SUBMITTED request exists (EpicStateError)", async () => {
    const person = await createPerson("Alice", { netId: "aaa001" });
    const manager = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(manager.id, "support.manage_requests");

    const req = await createEpicRequest(person.id, { personId: person.id, kind: "NEW" });
    // Move to SUBMITTED by creating a ticket.
    await prisma.epicRequest.update({ where: { id: req.id }, data: { status: "SUBMITTED" } });

    await expect(
      createEpicRequest(person.id, { personId: person.id, kind: "NEW" })
    ).rejects.toBeInstanceOf(EpicStateError);
  });

  it("NEW with existing epicId on person rejected (EpicStateError)", async () => {
    const person = await createPerson("Alice", { netId: "aaa001", epicId: "E12345" });

    await expect(
      createEpicRequest(person.id, { personId: person.id, kind: "NEW" })
    ).rejects.toBeInstanceOf(EpicStateError);
  });

  it("MODIFY without epicId on person rejected (EpicStateError)", async () => {
    const person = await createPerson("Alice", { netId: "aaa001" });

    await expect(
      createEpicRequest(person.id, { personId: person.id, kind: "MODIFY" })
    ).rejects.toBeInstanceOf(EpicStateError);
  });

  it("RENEW without epicId on person rejected (EpicStateError)", async () => {
    const person = await createPerson("Alice", { netId: "aaa001" });

    await expect(
      createEpicRequest(person.id, { personId: person.id, kind: "RENEW" })
    ).rejects.toBeInstanceOf(EpicStateError);
  });

  it("OFFBOARDED person rejected (EpicStateError)", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    const target = await createPerson("Offboarded", { netId: "off001", status: "OFFBOARDED" });
    await grantPermission(actor.id, "support.manage_requests");

    await expect(
      createEpicRequest(actor.id, { personId: target.id, kind: "NEW" })
    ).rejects.toBeInstanceOf(EpicStateError);
  });

  it("person not found -> EpicNotFoundError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");

    await expect(
      createEpicRequest(actor.id, { personId: "cld_nonexistent", kind: "NEW" })
    ).rejects.toBeInstanceOf(EpicNotFoundError);
  });
});

describe("createTicket", () => {
  it("happy path: ticket created, requests moved to SUBMITTED, audited", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");

    const p1 = await createPerson("Alice", { netId: "aaa001" });
    const p2 = await createPerson("Bob", { netId: "bbb001" });
    const req1 = await prisma.epicRequest.create({
      data: { personId: p1.id, kind: "NEW", status: "PENDING", requestedById: p1.id },
    });
    const req2 = await prisma.epicRequest.create({
      data: { personId: p2.id, kind: "NEW", status: "PENDING", requestedById: p2.id },
    });

    const ticket = await createTicket(actor.id, { requestIds: [req1.id, req2.id], description: "Batch 1" });

    expect(ticket.status).toBe("OPEN");
    expect(ticket.submittedById).toBe(actor.id);
    expect(ticket.description).toBe("Batch 1");

    const updated1 = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req1.id } });
    const updated2 = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req2.id } });
    expect(updated1.status).toBe("SUBMITTED");
    expect(updated2.status).toBe("SUBMITTED");
    expect(updated1.ticketId).toBe(ticket.id);
    expect(updated2.ticketId).toBe(ticket.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "epic.ticket_create", entityId: ticket.id },
    });
    expect(audit).not.toBeNull();
    const after = audit?.after as Record<string, unknown>;
    expect(after.requestIds).toEqual(expect.arrayContaining([req1.id, req2.id]));
  });

  it("non-PENDING id in requestIds -> EpicStateError listing offending ids", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");

    const p1 = await createPerson("Alice", { netId: "aaa001" });
    const p2 = await createPerson("Bob", { netId: "bbb001" });
    const pendingReq = await prisma.epicRequest.create({
      data: { personId: p1.id, kind: "NEW", status: "PENDING", requestedById: p1.id },
    });
    const completedReq = await prisma.epicRequest.create({
      data: { personId: p2.id, kind: "NEW", status: "COMPLETED", requestedById: p2.id },
    });

    await expect(
      createTicket(actor.id, { requestIds: [pendingReq.id, completedReq.id] })
    ).rejects.toBeInstanceOf(EpicStateError);
  });

  it("unknown id in requestIds -> EpicStateError, no ticket created, valid request stays PENDING", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");

    const p1 = await createPerson("Alice", { netId: "aaa001" });
    const validReq = await prisma.epicRequest.create({
      data: { personId: p1.id, kind: "NEW", status: "PENDING", requestedById: p1.id },
    });
    const fabricatedId = "00000000-0000-0000-0000-000000000000";

    await expect(
      createTicket(actor.id, { requestIds: [validReq.id, fabricatedId] })
    ).rejects.toBeInstanceOf(EpicStateError);

    // No ticket should have been created.
    const ticketCount = await prisma.ynhhTicket.count();
    expect(ticketCount).toBe(0);

    // The valid request must remain PENDING.
    const still = await prisma.epicRequest.findUniqueOrThrow({ where: { id: validReq.id } });
    expect(still.status).toBe("PENDING");
  });

  it("no permission -> EpicForbiddenError", async () => {
    const noPerms = await createPerson("NoPerms", { netId: "np001" });
    const target = await createPerson("Target", { netId: "tgt001" });
    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await expect(
      createTicket(noPerms.id, { requestIds: [req.id] })
    ).rejects.toBeInstanceOf(EpicForbiddenError);
  });

  it("empty requestIds array -> EpicStateError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");

    await expect(
      createTicket(actor.id, { requestIds: [] })
    ).rejects.toBeInstanceOf(EpicStateError);
  });

  it("concurrent double-submit: only one caller claims the request, the loser creates no ticket", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");

    const target = await createPerson("Alice", { netId: "aaa001" });
    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    // Fire two createTicket calls for the same PENDING request at once. Both
    // pass the outside-the-write pre-check, but the atomic PENDING claim lets
    // only one win; the loser matches zero rows, throws, and rolls back its own
    // ticket so no ticket is orphaned and the request is not reassigned.
    const results = await Promise.allSettled([
      createTicket(actor.id, { requestIds: [req.id] }),
      createTicket(actor.id, { requestIds: [req.id] }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(EpicStateError);

    // Exactly one ticket exists, and the request is linked to it as SUBMITTED.
    const tickets = await prisma.ynhhTicket.findMany();
    expect(tickets).toHaveLength(1);

    const updated = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updated.status).toBe("SUBMITTED");
    expect(updated.ticketId).toBe(tickets[0].id);
  });
});

// ---------------------------------------------------------------------------
// setTicketServiceRequestNumber
// ---------------------------------------------------------------------------

describe("setTicketServiceRequestNumber", () => {
  it("sets SR number and audits ticket_sr", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");

    const target = await createPerson("Alice", { netId: "aaa001" });
    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });
    const ticket = await createTicket(actor.id, { requestIds: [req.id] });

    await setTicketServiceRequestNumber(actor.id, ticket.id, "SR-9999");

    const updated = await prisma.ynhhTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(updated.serviceRequestNumber).toBe("SR-9999");

    const audit = await prisma.auditLog.findFirst({
      where: { action: "epic.ticket_sr", entityId: ticket.id },
    });
    expect(audit).not.toBeNull();
  });

  it("ticket not found -> EpicNotFoundError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");

    await expect(
      setTicketServiceRequestNumber(actor.id, "cld_nonexistent", "SR-0001")
    ).rejects.toBeInstanceOf(EpicNotFoundError);
  });

  it("no permission -> EpicForbiddenError", async () => {
    const noPerms = await createPerson("NoPerms", { netId: "np001" });

    await expect(
      setTicketServiceRequestNumber(noPerms.id, "some-ticket-id", "SR-0001")
    ).rejects.toBeInstanceOf(EpicForbiddenError);
  });
});

describe("completeRequest", () => {
  it("NEW: writes Person.epicId via updatePersonFields", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await completeRequest(actor.id, req.id, "E55555");

    const updatedPerson = await prisma.person.findUniqueOrThrow({ where: { id: target.id } });
    expect(updatedPerson.epicId).toBe("E55555");

    const updatedReq = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updatedReq.status).toBe("COMPLETED");
    expect(updatedReq.completedAt).not.toBeNull();

    // Audit for epic.complete.
    const audit = await prisma.auditLog.findFirst({
      where: { action: "epic.complete", entityId: req.id },
    });
    expect(audit).not.toBeNull();
  });

  it("MODIFY: writes Person.epicId via updatePersonFields", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");
    const target = await createPerson("Alice", { netId: "aaa001", epicId: "E11111" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "MODIFY", status: "PENDING", requestedById: target.id },
    });

    await completeRequest(actor.id, req.id, "E22222");

    const updatedPerson = await prisma.person.findUniqueOrThrow({ where: { id: target.id } });
    expect(updatedPerson.epicId).toBe("E22222");
  });

  it("RENEW: leaves person epicId untouched even when epicId passed", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");
    const target = await createPerson("Alice", { netId: "aaa001", epicId: "E33333" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "RENEW", status: "PENDING", requestedById: target.id },
    });

    // Should not throw, and should ignore the passed epicId.
    await completeRequest(actor.id, req.id, "E99999");

    const updatedPerson = await prisma.person.findUniqueOrThrow({ where: { id: target.id } });
    expect(updatedPerson.epicId).toBe("E33333");

    const updatedReq = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updatedReq.status).toBe("COMPLETED");

    // Audit row for RENEW must not record the caller-passed epicId.
    const audit = await prisma.auditLog.findFirst({
      where: { action: "epic.complete", entityId: req.id },
    });
    expect(audit).not.toBeNull();
    const after = audit?.after as Record<string, unknown>;
    expect(after.epicId).toBeNull();
  });

  it("NEW without epicId -> EpicStateError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await expect(completeRequest(actor.id, req.id)).rejects.toBeInstanceOf(EpicStateError);
  });

  it("NEW with blank epicId -> EpicStateError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await expect(completeRequest(actor.id, req.id, "  ")).rejects.toBeInstanceOf(EpicStateError);
  });

  it("COMPLETED status -> EpicStateError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");
    const target = await createPerson("Alice", { netId: "aaa001", epicId: "E11111" });

    const req = await prisma.epicRequest.create({
      data: {
        personId: target.id,
        kind: "RENEW",
        status: "COMPLETED",
        requestedById: target.id,
        completedAt: new Date(),
      },
    });

    await expect(completeRequest(actor.id, req.id)).rejects.toBeInstanceOf(EpicStateError);
  });

  it("CANCELLED status -> EpicStateError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");
    const target = await createPerson("Alice", { netId: "aaa001", epicId: "E11111" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "RENEW", status: "CANCELLED", requestedById: target.id },
    });

    await expect(completeRequest(actor.id, req.id)).rejects.toBeInstanceOf(EpicStateError);
  });

  it("not found -> EpicNotFoundError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");

    await expect(completeRequest(actor.id, "cld_nonexistent")).rejects.toBeInstanceOf(
      EpicNotFoundError
    );
  });

  it("no permission -> EpicForbiddenError", async () => {
    const noPerms = await createPerson("NoPerms", { netId: "np001" });
    const target = await createPerson("Alice", { netId: "aaa001", epicId: "E11111" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "RENEW", status: "PENDING", requestedById: target.id },
    });

    await expect(completeRequest(noPerms.id, req.id)).rejects.toBeInstanceOf(EpicForbiddenError);
  });

  it("rejects completing a NEW request when the person is not ACTIVE", async () => {
    const manager = await createPerson("Mgr");
    await grantPermission(manager.id, "support.manage_requests");
    const person = await createPerson("Leaver", { status: "OFFBOARDED" });
    const req = await prisma.epicRequest.create({
      data: { personId: person.id, kind: "NEW", status: "SUBMITTED", requestedById: manager.id },
    });

    await expect(completeRequest(manager.id, req.id, "NEWID")).rejects.toBeInstanceOf(EpicStateError);

    const after = await prisma.person.findUnique({ where: { id: person.id } });
    expect(after?.epicId).toBeNull();
  });

  it("rejects completing a RENEW request when the person is not ACTIVE", async () => {
    const manager = await createPerson("Mgr");
    await grantPermission(manager.id, "support.manage_requests");
    const person = await createPerson("Leaver", { epicId: "E123", status: "OFFBOARDED" });
    const req = await prisma.epicRequest.create({
      data: { personId: person.id, kind: "RENEW", status: "SUBMITTED", requestedById: manager.id },
    });

    await expect(completeRequest(manager.id, req.id)).rejects.toBeInstanceOf(EpicStateError);

    const stillOpen = await prisma.epicRequest.findUnique({ where: { id: req.id } });
    expect(stillOpen?.status).toBe("SUBMITTED");
  });

  it("completes a DEACTIVATE request for an OFFBOARDED person without clearing epicId", async () => {
    const manager = await createPerson("Mgr");
    await grantPermission(manager.id, "support.manage_requests");
    const person = await createPerson("Leaver", { epicId: "E123", status: "OFFBOARDED" });
    const req = await prisma.epicRequest.create({
      data: { personId: person.id, kind: "DEACTIVATE", status: "PENDING", requestedById: manager.id },
    });

    await completeRequest(manager.id, req.id);

    const done = await prisma.epicRequest.findUnique({ where: { id: req.id } });
    expect(done?.status).toBe("COMPLETED");
    expect(done?.completedAt).not.toBeNull();
    const after = await prisma.person.findUnique({ where: { id: person.id } });
    expect(after?.epicId).toBe("E123"); // never cleared
  });

  it("NEW happy path starting from SUBMITTED (request attached to a ticket)", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    // Attach to a ticket via createTicket (moves request to SUBMITTED).
    const ticket = await createTicket(actor.id, { requestIds: [req.id] });
    const submitted = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.ticketId).toBe(ticket.id);

    // Complete the SUBMITTED request.
    await completeRequest(actor.id, req.id, "E77777");

    const updatedPerson = await prisma.person.findUniqueOrThrow({ where: { id: target.id } });
    expect(updatedPerson.epicId).toBe("E77777");

    const updatedReq = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updatedReq.status).toBe("COMPLETED");
    expect(updatedReq.completedAt).not.toBeNull();

    // Audit records the trimmed epicId for NEW.
    const audit = await prisma.auditLog.findFirst({
      where: { action: "epic.complete", entityId: req.id },
    });
    expect(audit).not.toBeNull();
    const after = audit?.after as Record<string, unknown>;
    expect(after.epicId).toBe("E77777");
  });
});

describe("sendEpicEmail", () => {
  it("queues EmailLog row with right template/to/personId/triggeredById", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001", contactEmail: "mgr@yale.edu" });
    await grantPermission(actor.id, "support.manage_requests");
    const target = await createPerson("Alice", { netId: "aaa001", contactEmail: "alice@yale.edu" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await sendEpicEmail(actor.id, req.id, "epic-onboarding");

    const log = await prisma.emailLog.findFirst({
      where: { personId: target.id, template: "epic-onboarding" },
    });
    expect(log).not.toBeNull();
    expect(log?.toEmail).toBe("alice@yale.edu");
    expect(log?.triggeredById).toBe(actor.id);
    expect(log?.personId).toBe(target.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "epic.email", entityId: req.id },
    });
    expect(audit).not.toBeNull();
    const after = audit?.after as Record<string, unknown>;
    expect(after.template).toBe("epic-onboarding");
  });

  it("includes departmentNames from ACTIVE memberships in ACTIVE term", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");
    const target = await createPerson("Alice", { netId: "aaa001", contactEmail: "alice@yale.edu" });

    const term = await createTerm();
    const dept = await createDepartment("SRR");
    await createMembership(target.id, term.id, dept.id, "VOLUNTEER");

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await sendEpicEmail(actor.id, req.id, "epic-onboarding");

    const log = await prisma.emailLog.findFirst({ where: { personId: target.id } });
    expect(log?.html).toContain("SRR Dept");
  });

  it("no contactEmail -> EpicStateError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");
    const target = await createPerson("Alice", { netId: "aaa001" }); // no contactEmail

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await expect(sendEpicEmail(actor.id, req.id, "epic-onboarding")).rejects.toBeInstanceOf(
      EpicStateError
    );
  });

  it("no permission -> EpicForbiddenError", async () => {
    const noPerms = await createPerson("NoPerms", { netId: "np001" });
    const target = await createPerson("Alice", { netId: "aaa001", contactEmail: "alice@yale.edu" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await expect(sendEpicEmail(noPerms.id, req.id, "epic-onboarding")).rejects.toBeInstanceOf(
      EpicForbiddenError
    );
  });

  it("request not found -> EpicNotFoundError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "support.manage_requests");

    await expect(sendEpicEmail(actor.id, "cld_nonexistent", "epic-onboarding")).rejects.toBeInstanceOf(
      EpicNotFoundError
    );
  });

  it("queues a Teams message when the EPIC type routes to teams", async () => {
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("teams");
    const actor = await createPerson("Manager", { netId: "mgr001", contactEmail: "mgr@yale.edu" });
    await grantPermission(actor.id, "support.manage_requests");
    const target = await createPerson("Alice", { netId: "aaa001", contactEmail: "alice@yale.edu" });
    await prisma.person.update({ where: { id: target.id }, data: { entraObjectId: "e-epic" } });

    const request = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await sendEpicEmail(actor.id, request.id, "epic-onboarding");

    const teams = await prisma.teamsMessage.findFirst({ where: { type: "epic-onboarding" } });
    expect(teams).not.toBeNull();

    vi.restoreAllMocks();
  });
});

describe("cancelEpicRequest", () => {
  async function pendingRequest(personId: string, requestedById: string) {
    return prisma.epicRequest.create({
      data: { personId, kind: "NEW", status: "PENDING", requestedById },
    });
  }

  it("cancels a PENDING request and audits", async () => {
    const person = await createPerson("P", { epicId: "E-123" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await pendingRequest(person.id, mgr.id);

    await cancelEpicRequest(mgr.id, req.id);

    const after = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe("CANCELLED");
    const audit = await prisma.auditLog.findFirst({ where: { action: "epic.cancel", entityId: req.id } });
    expect(audit).not.toBeNull();

    // cancelEpicRequest must not touch Person.epicId.
    const stillThere = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(stillThere.epicId).toBe("E-123");
  });

  it("refuses to cancel a non-PENDING request", async () => {
    const person = await createPerson("P");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await pendingRequest(person.id, mgr.id);
    await prisma.epicRequest.update({ where: { id: req.id }, data: { status: "SUBMITTED" } });

    await expect(cancelEpicRequest(mgr.id, req.id)).rejects.toThrow(EpicStateError);
  });

  it("rejects a non-manager", async () => {
    const person = await createPerson("P");
    const other = await createPerson("Other");
    const req = await pendingRequest(person.id, other.id);
    await expect(cancelEpicRequest(other.id, req.id)).rejects.toThrow(EpicForbiddenError);
  });

  it("raises not-found for a missing request", async () => {
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    await expect(cancelEpicRequest(mgr.id, "nope")).rejects.toThrow(EpicNotFoundError);
  });
});
