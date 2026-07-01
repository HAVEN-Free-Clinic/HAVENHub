/**
 * TDD tests for the volunteers epic request service.
 *
 * createEpicRequest(actorPersonId, input):
 *   - Self-create NEW happy path; audit row with kind in after.
 *   - Non-manager cannot create for someone else (EpicForbiddenError).
 *   - Manager (volunteers.manage_epic) creates for anyone.
 *   - Duplicate-open rejected when PENDING request exists (EpicStateError).
 *   - Duplicate-open rejected when SUBMITTED request exists (EpicStateError).
 *   - NEW with existing epicId on person rejected (EpicStateError).
 *   - MODIFY without epicId on person rejected (EpicStateError).
 *   - OFFBOARDED person rejected (EpicStateError).
 *   - Person not found -> EpicNotFoundError.
 *
 * myEpicPanel(personId):
 *   - Returns epicId + open request or null.
 *
 * listEpicRequests(q):
 *   - Filters by status, newest first, includes person + ticket.
 *   - Counts across ALL requests regardless of filter.
 *   - Pagination: 26 rows -> page 2 has 1 row.
 *
 * createTicket(actorPersonId, input):
 *   - Happy path: ticket created, requests moved to SUBMITTED.
 *   - Non-PENDING id in requestIds -> EpicStateError.
 *   - Unknown id in requestIds -> EpicStateError, no ticket created, valid request stays PENDING.
 *   - No permission -> EpicForbiddenError.
 *
 * setTicketServiceRequestNumber + closeTicket:
 *   - Sets SR number; audits ticket_sr.
 *   - closeTicket sets CLOSED + closedAt; audits ticket_close.
 *   - closeTicket on already-closed ticket -> EpicStateError.
 *
 * completeRequest(actorPersonId, requestId, epicId?):
 *   - NEW: writes Person.epicId via updatePersonFields.
 *   - RENEW: leaves person untouched even when epicId passed.
 *   - NEW without epicId -> EpicStateError.
 *   - COMPLETED/CANCELLED status -> EpicStateError.
 *   - Not found -> EpicNotFoundError.
 *
 * cancelRequest(actorPersonId, requestId, reason):
 *   - Appends reason to existing notes.
 *   - Works when notes is null.
 *   - Blank reason -> EpicStateError.
 *
 * sendEpicEmail(actorPersonId, requestId, template):
 *   - Queues EmailLog row with right template/to/personId/triggeredById.
 *   - No contactEmail -> EpicStateError.
 *   - No permission -> EpicForbiddenError.
 *
 * emailHistory(personIds):
 *   - Groups by personId, excludes non-epic templates.
 *
 * updateRequestDetails(actorPersonId, requestId, input):
 *   - Happy path: sets both jobTitle and mirrorEpicId; audit row exists.
 *   - Partial update: only jobTitle provided; mirrorEpicId untouched.
 *   - Clearing with null clears the field; clearing with "" clears the field.
 *   - No permission -> EpicForbiddenError.
 *   - Not found -> EpicNotFoundError.
 *   - COMPLETED request rejected -> EpicStateError.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as channel from "@/platform/notifications/channel";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createEpicRequest,
  myEpicPanel,
  listEpicRequests,
  createTicket,
  setTicketServiceRequestNumber,
  closeTicket,
  listTickets,
  completeRequest,
  cancelRequest,
  sendEpicEmail,
  emailHistory,
  updateRequestDetails,
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

  it("manager (volunteers.manage_epic) creates for anyone", async () => {
    const manager = await createPerson("Manager", { netId: "mgr001" });
    const target = await createPerson("Target", { netId: "tgt001" });
    await grantPermission(manager.id, "volunteers.manage_epic");

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
    await grantPermission(manager.id, "volunteers.manage_epic");

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
    await grantPermission(actor.id, "volunteers.manage_epic");

    await expect(
      createEpicRequest(actor.id, { personId: target.id, kind: "NEW" })
    ).rejects.toBeInstanceOf(EpicStateError);
  });

  it("person not found -> EpicNotFoundError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");

    await expect(
      createEpicRequest(actor.id, { personId: "cld_nonexistent", kind: "NEW" })
    ).rejects.toBeInstanceOf(EpicNotFoundError);
  });
});

describe("myEpicPanel", () => {
  it("returns epicId and open PENDING request", async () => {
    const person = await createPerson("Alice", { netId: "aaa001", epicId: "E99" });
    const req = await prisma.epicRequest.create({
      data: { personId: person.id, kind: "RENEW", status: "PENDING", requestedById: person.id },
    });

    const panel = await myEpicPanel(person.id);
    expect(panel.epicId).toBe("E99");
    expect(panel.openRequest?.id).toBe(req.id);
  });

  it("returns epicId and open SUBMITTED request", async () => {
    const person = await createPerson("Bob", { netId: "bbb001", epicId: "E88" });
    const req = await prisma.epicRequest.create({
      data: { personId: person.id, kind: "RENEW", status: "SUBMITTED", requestedById: person.id },
    });

    const panel = await myEpicPanel(person.id);
    expect(panel.epicId).toBe("E88");
    expect(panel.openRequest?.id).toBe(req.id);
  });

  it("returns null openRequest when no open request exists", async () => {
    const person = await createPerson("Carol", { netId: "ccc001" });

    const panel = await myEpicPanel(person.id);
    expect(panel.epicId).toBeNull();
    expect(panel.openRequest).toBeNull();
  });

  it("ignores COMPLETED and CANCELLED requests", async () => {
    const person = await createPerson("Dave", { netId: "ddd001", epicId: "E77" });
    await prisma.epicRequest.create({
      data: { personId: person.id, kind: "RENEW", status: "COMPLETED", requestedById: person.id },
    });

    const panel = await myEpicPanel(person.id);
    expect(panel.openRequest).toBeNull();
  });
});

describe("listEpicRequests", () => {
  it("returns filtered rows, correct counts, person + ticket fields", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const mgr = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(mgr.id, "volunteers.manage_epic");
    await createMembership(mgr.id, term.id, dept.id, "DIRECTOR");

    const p1 = await createPerson("Alice", { netId: "aaa001", contactEmail: "alice@yale.edu" });
    const p2 = await createPerson("Bob", { netId: "bbb001", contactEmail: "bob@yale.edu" });

    const req1 = await prisma.epicRequest.create({
      data: { personId: p1.id, kind: "NEW", status: "PENDING", requestedById: p1.id },
    });
    await prisma.epicRequest.create({
      data: { personId: p2.id, kind: "NEW", status: "COMPLETED", requestedById: p2.id },
    });

    const result = await listEpicRequests({ status: "PENDING" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(req1.id);
    expect(result.rows[0].person.id).toBe(p1.id);

    // counts across ALL requests (PENDING + COMPLETED)
    expect(result.counts.PENDING).toBe(1);
    expect(result.counts.COMPLETED).toBe(1);
    expect(result.counts.SUBMITTED).toBe(0);
    expect(result.counts.CANCELLED).toBe(0);
    expect(result.total).toBe(1); // total reflects the filtered result
  });

  it("rows include ticket when attached", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });
    const ticket = await createTicket(actor.id, { requestIds: [req.id] });

    const result = await listEpicRequests({ status: "SUBMITTED" });
    expect(result.rows[0].ticket?.id).toBe(ticket.id);
  });

  it("pagination: 26 rows -> page 2 has 1 row", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    for (let i = 0; i < 26; i++) {
      const p = await createPerson(`Person${i}`, { netId: `p${String(i).padStart(3, "0")}` });
      await prisma.epicRequest.create({
        data: { personId: p.id, kind: "NEW", status: "PENDING", requestedById: actor.id },
      });
    }

    const page1 = await listEpicRequests({ status: "PENDING", page: 1 });
    expect(page1.rows).toHaveLength(25);
    expect(page1.total).toBe(26);

    const page2 = await listEpicRequests({ status: "PENDING", page: 2 });
    expect(page2.rows).toHaveLength(1);
  });
});

describe("createTicket", () => {
  it("happy path: ticket created, requests moved to SUBMITTED, audited", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");

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
    await grantPermission(actor.id, "volunteers.manage_epic");

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
    await grantPermission(actor.id, "volunteers.manage_epic");

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
    await grantPermission(actor.id, "volunteers.manage_epic");

    await expect(
      createTicket(actor.id, { requestIds: [] })
    ).rejects.toBeInstanceOf(EpicStateError);
  });
});

// ---------------------------------------------------------------------------
// setTicketServiceRequestNumber + closeTicket
// ---------------------------------------------------------------------------

describe("setTicketServiceRequestNumber", () => {
  it("sets SR number and audits ticket_sr", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");

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
    await grantPermission(actor.id, "volunteers.manage_epic");

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

describe("closeTicket", () => {
  it("sets status CLOSED + closedAt and audits ticket_close", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");

    const target = await createPerson("Alice", { netId: "aaa001" });
    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });
    const ticket = await createTicket(actor.id, { requestIds: [req.id] });

    await closeTicket(actor.id, ticket.id);

    const updated = await prisma.ynhhTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(updated.status).toBe("CLOSED");
    expect(updated.closedAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { action: "epic.ticket_close", entityId: ticket.id },
    });
    expect(audit).not.toBeNull();
  });

  it("already-closed ticket -> EpicStateError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");

    const target = await createPerson("Alice", { netId: "aaa001" });
    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });
    const ticket = await createTicket(actor.id, { requestIds: [req.id] });
    await closeTicket(actor.id, ticket.id);

    await expect(closeTicket(actor.id, ticket.id)).rejects.toBeInstanceOf(EpicStateError);
  });

  it("ticket not found -> EpicNotFoundError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");

    await expect(closeTicket(actor.id, "cld_nonexistent")).rejects.toBeInstanceOf(EpicNotFoundError);
  });

  it("no permission -> EpicForbiddenError", async () => {
    const noPerms = await createPerson("NoPerms", { netId: "np001" });

    await expect(closeTicket(noPerms.id, "some-ticket-id")).rejects.toBeInstanceOf(EpicForbiddenError);
  });
});

describe("completeRequest", () => {
  it("NEW: writes Person.epicId via updatePersonFields", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");
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
    await grantPermission(actor.id, "volunteers.manage_epic");
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
    await grantPermission(actor.id, "volunteers.manage_epic");
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
    await grantPermission(actor.id, "volunteers.manage_epic");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await expect(completeRequest(actor.id, req.id)).rejects.toBeInstanceOf(EpicStateError);
  });

  it("NEW with blank epicId -> EpicStateError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await expect(completeRequest(actor.id, req.id, "  ")).rejects.toBeInstanceOf(EpicStateError);
  });

  it("COMPLETED status -> EpicStateError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");
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
    await grantPermission(actor.id, "volunteers.manage_epic");
    const target = await createPerson("Alice", { netId: "aaa001", epicId: "E11111" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "RENEW", status: "CANCELLED", requestedById: target.id },
    });

    await expect(completeRequest(actor.id, req.id)).rejects.toBeInstanceOf(EpicStateError);
  });

  it("not found -> EpicNotFoundError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");

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
    await grantPermission(manager.id, "volunteers.manage_epic");
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
    await grantPermission(manager.id, "volunteers.manage_epic");
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
    await grantPermission(manager.id, "volunteers.manage_epic");
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
    await grantPermission(actor.id, "volunteers.manage_epic");
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

describe("cancelRequest", () => {
  it("appends reason to existing notes and sets CANCELLED", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: {
        personId: target.id,
        kind: "NEW",
        status: "PENDING",
        requestedById: target.id,
        notes: "Original notes",
      },
    });

    await cancelRequest(actor.id, req.id, "Withdrew application");

    const updated = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updated.status).toBe("CANCELLED");
    expect(updated.notes).toBe("Original notes\nCancelled: Withdrew application");

    const audit = await prisma.auditLog.findFirst({
      where: { action: "epic.cancel", entityId: req.id },
    });
    expect(audit).not.toBeNull();
    const after = audit?.after as Record<string, unknown>;
    expect(after.reason).toBe("Withdrew application");
  });

  it("works when notes is null (no leading newline)", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await cancelRequest(actor.id, req.id, "No longer a volunteer");

    const updated = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updated.notes).toBe("Cancelled: No longer a volunteer");
  });

  it("blank reason -> EpicStateError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await expect(cancelRequest(actor.id, req.id, "  ")).rejects.toBeInstanceOf(EpicStateError);
    await expect(cancelRequest(actor.id, req.id, "")).rejects.toBeInstanceOf(EpicStateError);
  });

  it("no permission -> EpicForbiddenError", async () => {
    const noPerms = await createPerson("NoPerms", { netId: "np001" });
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await expect(cancelRequest(noPerms.id, req.id, "reason")).rejects.toBeInstanceOf(
      EpicForbiddenError
    );
  });

  it("not found -> EpicNotFoundError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");

    await expect(cancelRequest(actor.id, "cld_nonexistent", "reason")).rejects.toBeInstanceOf(
      EpicNotFoundError
    );
  });
});

describe("sendEpicEmail", () => {
  it("queues EmailLog row with right template/to/personId/triggeredById", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001", contactEmail: "mgr@yale.edu" });
    await grantPermission(actor.id, "volunteers.manage_epic");
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
    await grantPermission(actor.id, "volunteers.manage_epic");
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
    await grantPermission(actor.id, "volunteers.manage_epic");
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
    await grantPermission(actor.id, "volunteers.manage_epic");

    await expect(sendEpicEmail(actor.id, "cld_nonexistent", "epic-onboarding")).rejects.toBeInstanceOf(
      EpicNotFoundError
    );
  });

  it("queues a Teams message when the EPIC type routes to teams", async () => {
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("teams");
    const actor = await createPerson("Manager", { netId: "mgr001", contactEmail: "mgr@yale.edu" });
    await grantPermission(actor.id, "volunteers.manage_epic");
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

describe("emailHistory", () => {
  it("groups by personId, includes only epic templates, newest first", async () => {
    const p1 = await createPerson("Alice", { netId: "aaa001" });
    const p2 = await createPerson("Bob", { netId: "bbb001" });

    const earlier = new Date("2026-01-01");
    const later = new Date("2026-06-01");

    await prisma.emailLog.create({
      data: {
        toEmail: "alice@yale.edu",
        subject: "S1",
        html: "<p>1</p>",
        template: "epic-onboarding",
        personId: p1.id,
        createdAt: earlier,
      },
    });
    await prisma.emailLog.create({
      data: {
        toEmail: "alice@yale.edu",
        subject: "S2",
        html: "<p>2</p>",
        template: "epic-activation",
        personId: p1.id,
        createdAt: later,
      },
    });
    await prisma.emailLog.create({
      data: {
        toEmail: "alice@yale.edu",
        subject: "Non-epic",
        html: "<p>x</p>",
        template: "some-other-template",
        personId: p1.id,
        createdAt: later,
      },
    });
    await prisma.emailLog.create({
      data: {
        toEmail: "bob@yale.edu",
        subject: "S3",
        html: "<p>3</p>",
        template: "epic-password-reset",
        personId: p2.id,
        createdAt: later,
      },
    });

    const history = await emailHistory([p1.id, p2.id]);

    expect(history.size).toBe(2);

    const p1Logs = history.get(p1.id)!;
    expect(p1Logs).toHaveLength(2); // excludes the non-epic template
    // newest first: epic-activation (later) should come first
    expect(p1Logs[0].template).toBe("epic-activation");
    expect(p1Logs[1].template).toBe("epic-onboarding");

    const p2Logs = history.get(p2.id)!;
    expect(p2Logs).toHaveLength(1);
    expect(p2Logs[0].template).toBe("epic-password-reset");
  });

  it("excludes personIds not in the input list", async () => {
    const p1 = await createPerson("Alice", { netId: "aaa001" });
    const p2 = await createPerson("Bob", { netId: "bbb001" });

    await prisma.emailLog.create({
      data: {
        toEmail: "alice@yale.edu",
        subject: "S",
        html: "<p>x</p>",
        template: "epic-onboarding",
        personId: p1.id,
      },
    });
    await prisma.emailLog.create({
      data: {
        toEmail: "bob@yale.edu",
        subject: "S",
        html: "<p>x</p>",
        template: "epic-onboarding",
        personId: p2.id,
      },
    });

    const history = await emailHistory([p1.id]);
    expect(history.has(p1.id)).toBe(true);
    expect(history.has(p2.id)).toBe(false);
  });

  it("returns empty map for empty personIds input", async () => {
    const history = await emailHistory([]);
    expect(history.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listTickets
// ---------------------------------------------------------------------------

describe("updateRequestDetails", () => {
  it("happy path: sets both jobTitle and mirrorEpicId; audit row exists with before/after", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await updateRequestDetails(actor.id, req.id, {
      jobTitle: "Volunteer Clinician",
      mirrorEpicId: "E11111",
    });

    const updated = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updated.jobTitle).toBe("Volunteer Clinician");
    expect(updated.mirrorEpicId).toBe("E11111");

    const audit = await prisma.auditLog.findFirst({
      where: { action: "epic.update_details", entityId: req.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorPersonId).toBe(actor.id);
    const before = audit?.before as Record<string, unknown>;
    const after = audit?.after as Record<string, unknown>;
    expect(before.jobTitle).toBeNull();
    expect(before.mirrorEpicId).toBeNull();
    expect(after.jobTitle).toBe("Volunteer Clinician");
    expect(after.mirrorEpicId).toBe("E11111");
  });

  it("partial update: only jobTitle; mirrorEpicId untouched", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: {
        personId: target.id,
        kind: "NEW",
        status: "PENDING",
        requestedById: target.id,
        mirrorEpicId: "E99999",
      },
    });

    await updateRequestDetails(actor.id, req.id, { jobTitle: "New Title" });

    const updated = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updated.jobTitle).toBe("New Title");
    expect(updated.mirrorEpicId).toBe("E99999");
  });

  it("clearing with null clears the field", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: {
        personId: target.id,
        kind: "NEW",
        status: "PENDING",
        requestedById: target.id,
        jobTitle: "Old Title",
        mirrorEpicId: "E88888",
      },
    });

    await updateRequestDetails(actor.id, req.id, { jobTitle: null, mirrorEpicId: null });

    const updated = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updated.jobTitle).toBeNull();
    expect(updated.mirrorEpicId).toBeNull();
  });

  it("clearing with empty string clears the field (treated as null)", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: {
        personId: target.id,
        kind: "NEW",
        status: "PENDING",
        requestedById: target.id,
        jobTitle: "Old Title",
        mirrorEpicId: "E77777",
      },
    });

    await updateRequestDetails(actor.id, req.id, { jobTitle: "", mirrorEpicId: "" });

    const updated = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updated.jobTitle).toBeNull();
    expect(updated.mirrorEpicId).toBeNull();
  });

  it("no permission -> EpicForbiddenError", async () => {
    const noPerms = await createPerson("NoPerms", { netId: "np001" });
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "PENDING", requestedById: target.id },
    });

    await expect(
      updateRequestDetails(noPerms.id, req.id, { jobTitle: "Title" })
    ).rejects.toBeInstanceOf(EpicForbiddenError);
  });

  it("not found -> EpicNotFoundError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");

    await expect(
      updateRequestDetails(actor.id, "cld_nonexistent", { jobTitle: "Title" })
    ).rejects.toBeInstanceOf(EpicNotFoundError);
  });

  it("COMPLETED request rejected -> EpicStateError", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");
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

    await expect(
      updateRequestDetails(actor.id, req.id, { jobTitle: "Title" })
    ).rejects.toBeInstanceOf(EpicStateError);
  });

  it("SUBMITTED (open) request is accepted", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");
    const target = await createPerson("Alice", { netId: "aaa001" });

    const req = await prisma.epicRequest.create({
      data: { personId: target.id, kind: "NEW", status: "SUBMITTED", requestedById: target.id },
    });

    await expect(
      updateRequestDetails(actor.id, req.id, { jobTitle: "Volunteer" })
    ).resolves.toBeUndefined();

    const updated = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(updated.jobTitle).toBe("Volunteer");
  });
});

describe("listTickets", () => {
  it("returns OPEN tickets first then CLOSED, includes request count", async () => {
    const actor = await createPerson("Manager", { netId: "mgr001" });
    await grantPermission(actor.id, "volunteers.manage_epic");

    const p1 = await createPerson("Alice", { netId: "aaa001" });
    const p2 = await createPerson("Bob", { netId: "bbb001" });
    const p3 = await createPerson("Carol", { netId: "ccc001" });

    const req1 = await prisma.epicRequest.create({
      data: { personId: p1.id, kind: "NEW", status: "PENDING", requestedById: p1.id },
    });
    const req2 = await prisma.epicRequest.create({
      data: { personId: p2.id, kind: "NEW", status: "PENDING", requestedById: p2.id },
    });
    const req3 = await prisma.epicRequest.create({
      data: { personId: p3.id, kind: "NEW", status: "PENDING", requestedById: p3.id },
    });

    const ticket1 = await createTicket(actor.id, { requestIds: [req1.id, req2.id] });
    const ticket2 = await createTicket(actor.id, { requestIds: [req3.id] });
    await closeTicket(actor.id, ticket2.id);

    const tickets = await listTickets();

    // OPEN first.
    expect(tickets[0].id).toBe(ticket1.id);
    expect(tickets[0]._count.requests).toBe(2);

    // CLOSED second.
    expect(tickets[1].id).toBe(ticket2.id);
    expect(tickets[1]._count.requests).toBe(1);
    expect(tickets[1].closedAt).not.toBeNull();
  });
});
