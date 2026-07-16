import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  authorizerInitials,
  listEpicAuthorizers,
  listPendingDeactivations,
  listPendingEpicRequests,
  reconcileDeactivationRequests,
  submitEpicRequests,
  logYnhhIncident,
  resolveIncident,
  getEpicRequestHistory,
  listIncidentPeople,
} from "./itcm";
import { persistAttachment } from "./attachments";
import { createTechRequest, SupportConflictError, SupportForbiddenError, SupportNotFoundError, SupportStateError } from "./tech-request";

// ---------------------------------------------------------------------------
// Helpers (copied from tech-request.test.ts / epic.test.ts)
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

describe("authorizerInitials", () => {
  it("returns the first and last token initials, uppercased", () => {
    expect(authorizerInitials("Caprice Culkin")).toBe("CC");
    expect(authorizerInitials("Renee Tracey")).toBe("RT");
    expect(authorizerInitials("Jack Carney")).toBe("JC");
  });

  it("uses the first and final token for multi-part names", () => {
    expect(authorizerInitials("Mary Jane Watson")).toBe("MW");
  });

  it("handles a single-token name and stray whitespace", () => {
    expect(authorizerInitials("Cher")).toBe("C");
    expect(authorizerInitials("  Ada   Lovelace  ")).toBe("AL");
    expect(authorizerInitials("")).toBe("");
  });
});

describe("listEpicAuthorizers", () => {
  beforeEach(resetDb);

  async function activeItcm() {
    const term = await prisma.term.create({
      data: { code: "SU26", name: "Summer 2026", startDate: new Date("2026-06-01"), endDate: new Date("2026-08-31"), status: "ACTIVE" },
    });
    const itcm = await prisma.department.create({ data: { code: "ITCM", name: "IT & Compliance Management" } });
    return { term, itcm };
  }

  it("returns ACTIVE ITCM directors of the active term with name, phone, email, and initials", async () => {
    const { term, itcm } = await activeItcm();
    const cc = await prisma.person.create({
      data: { name: "Caprice Culkin", phone: "720-254-2589", contactEmail: "caprice.culkin@yale.edu" },
    });
    await prisma.termMembership.create({
      data: { personId: cc.id, termId: term.id, departmentId: itcm.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    const rows = await listEpicAuthorizers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: cc.id,
      name: "Caprice Culkin",
      phone: "720-254-2589",
      email: "caprice.culkin@yale.edu",
      initials: "CC",
    });
  });

  it("excludes ITCM volunteers and directors of other departments", async () => {
    const { term, itcm } = await activeItcm();
    const exec = await prisma.department.create({ data: { code: "EXEC", name: "Executive Directors" } });
    const vol = await prisma.person.create({ data: { name: "Vol Unteer", contactEmail: "v@yale.edu" } });
    const execDir = await prisma.person.create({ data: { name: "Exec Director", contactEmail: "e@yale.edu" } });
    await prisma.termMembership.create({
      data: { personId: vol.id, termId: term.id, departmentId: itcm.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: execDir.id, termId: term.id, departmentId: exec.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    expect(await listEpicAuthorizers()).toEqual([]);
  });

  it("excludes REMOVED memberships and directors from inactive terms", async () => {
    const { term, itcm } = await activeItcm();
    const oldTerm = await prisma.term.create({
      data: { code: "SP26", name: "Spring 2026", startDate: new Date("2026-01-01"), endDate: new Date("2026-05-31"), status: "ARCHIVED" },
    });
    const removed = await prisma.person.create({ data: { name: "Removed Dir", contactEmail: "r@yale.edu" } });
    const oldDir = await prisma.person.create({ data: { name: "Old Dir", contactEmail: "o@yale.edu" } });
    await prisma.termMembership.create({
      data: { personId: removed.id, termId: term.id, departmentId: itcm.id, kind: "DIRECTOR", status: "REMOVED" },
    });
    await prisma.termMembership.create({
      data: { personId: oldDir.id, termId: oldTerm.id, departmentId: itcm.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    expect(await listEpicAuthorizers()).toEqual([]);
  });

  it("defaults phone and email to empty strings when the person has none", async () => {
    const { term, itcm } = await activeItcm();
    const p = await prisma.person.create({ data: { name: "No Contact" } });
    await prisma.termMembership.create({
      data: { personId: p.id, termId: term.id, departmentId: itcm.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    const rows = await listEpicAuthorizers();
    expect(rows[0]).toMatchObject({ name: "No Contact", phone: "", email: "", initials: "NC" });
  });

  it("returns an empty list when there is no active term", async () => {
    expect(await listEpicAuthorizers()).toEqual([]);
  });
});

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

describe("listPendingEpicRequests", () => {
  beforeEach(resetDb);

  it("returns an attach-origin request (PENDING, ticketId null, techRequestId set)", async () => {
    const mgr = await createPerson("Manager");
    const requester = await createPerson("Requester");
    const t = await createTechRequest(requester.id, {
      category: "EPIC",
      subject: "Need Epic access",
      description: "d",
    });
    const attached = await prisma.epicRequest.create({
      data: {
        personId: requester.id,
        kind: "NEW",
        status: "PENDING",
        requestedById: mgr.id,
        techRequestId: t.id,
      },
    });

    const rows = await listPendingEpicRequests();
    expect(rows.map((r) => r.id)).toEqual([attached.id]);
    expect(rows[0].techRequest).toMatchObject({ id: t.id, number: t.number, subject: t.subject });
  });

  it("includes a promotion-origin NEW request (no techRequestId) but excludes DEACTIVATE", async () => {
    const mgr = await createPerson("Manager");
    const offboarded = await createPerson("Offboarded", { status: "OFFBOARDED" });
    const promoted = await createPerson("Promoted");

    // Offboarding queues a DEACTIVATE with no ticket and no techRequestId -- it has
    // its own pipeline and must NOT appear here.
    await prisma.epicRequest.create({
      data: { personId: offboarded.id, kind: "DEACTIVATE", status: "PENDING", requestedById: mgr.id },
    });
    // Recruitment promotion queues a NEW the same way -- it MUST appear here so the
    // promoted volunteer can actually be provisioned (previously it was stranded).
    const promo = await prisma.epicRequest.create({
      data: { personId: promoted.id, kind: "NEW", status: "PENDING", requestedById: mgr.id },
    });

    const rows = await listPendingEpicRequests();
    expect(rows.map((r) => r.id)).toEqual([promo.id]);
    expect(rows[0].techRequest).toBeNull();
  });

  it("excludes a request already grouped under a YnhhTicket", async () => {
    const mgr = await createPerson("Manager");
    const requester = await createPerson("Requester");
    const t = await createTechRequest(requester.id, {
      category: "EPIC",
      subject: "Need Epic access",
      description: "d",
    });
    const ticket = await prisma.ynhhTicket.create({ data: { submittedById: mgr.id, status: "OPEN" } });
    await prisma.epicRequest.create({
      data: {
        personId: requester.id,
        kind: "NEW",
        status: "PENDING",
        requestedById: mgr.id,
        techRequestId: t.id,
        ticketId: ticket.id,
      },
    });

    expect(await listPendingEpicRequests()).toEqual([]);
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

    const ticket = await reconcileDeactivationRequests(actor.id, [withReq.id, withoutReq.id], "Deactivate - HasReq, NoReq");
    expect(ticket.status).toBe("OPEN");

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

  it("leaves an already-SUBMITTED DEACTIVATE on its ticket (no orphan) and rejects when nothing is new", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor" } });
    const person = await prisma.person.create({ data: { name: "AlreadySubmitted", epicId: "E3", status: "OFFBOARDED" } });
    const oldTicket = await prisma.ynhhTicket.create({ data: { submittedById: actor.id, status: "OPEN" } });
    const existing = await prisma.epicRequest.create({
      data: { personId: person.id, kind: "DEACTIVATE", status: "SUBMITTED", ticketId: oldTicket.id, requestedById: actor.id },
    });
    const ticketsBefore = await prisma.ynhhTicket.count();

    // Re-running Generate for a person whose deactivation is already submitted must
    // NOT create a second ticket and re-point the request to it (that orphaned the
    // first ticket -- audit finding #16). With nothing new to submit it rejects.
    await expect(
      reconcileDeactivationRequests(actor.id, [person.id], "Deactivate - AlreadySubmitted"),
    ).rejects.toBeInstanceOf(SupportStateError);

    // No new ticket, and the request stays on its original ticket.
    expect(await prisma.ynhhTicket.count()).toBe(ticketsBefore);
    const untouched = await prisma.epicRequest.findUnique({ where: { id: existing.id } });
    expect(untouched?.ticketId).toBe(oldTicket.id);
    expect(untouched?.status).toBe("SUBMITTED");
  });

  it("submits the new/pending people while skipping an already-submitted one (mixed batch)", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor" } });
    const submitted = await prisma.person.create({ data: { name: "Submitted", status: "OFFBOARDED" } });
    const pending = await prisma.person.create({ data: { name: "Pending", status: "OFFBOARDED" } });
    const oldTicket = await prisma.ynhhTicket.create({ data: { submittedById: actor.id, status: "OPEN" } });
    const already = await prisma.epicRequest.create({
      data: { personId: submitted.id, kind: "DEACTIVATE", status: "SUBMITTED", ticketId: oldTicket.id, requestedById: actor.id },
    });
    await prisma.epicRequest.create({
      data: { personId: pending.id, kind: "DEACTIVATE", status: "PENDING", requestedById: actor.id },
    });

    const newTicket = await reconcileDeactivationRequests(actor.id, [submitted.id, pending.id], "Deactivate - mixed");
    expect(newTicket.id).not.toBe(oldTicket.id);
    // The already-submitted request stays on its old ticket.
    expect((await prisma.epicRequest.findUniqueOrThrow({ where: { id: already.id } })).ticketId).toBe(oldTicket.id);
    // The pending one moves onto the new ticket.
    const movedList = await prisma.epicRequest.findMany({ where: { personId: pending.id, kind: "DEACTIVATE" } });
    expect(movedList).toHaveLength(1);
    expect(movedList[0].ticketId).toBe(newTicket.id);
    expect(movedList[0].status).toBe("SUBMITTED");
  });

  it("does not leave an orphan OPEN ticket when the batch fails partway (F18)", async () => {
    const actor = await prisma.person.create({ data: { name: "Actor" } });
    const ok = await prisma.person.create({ data: { name: "OK", status: "OFFBOARDED" } });
    const ticketsBefore = await prisma.ynhhTicket.count();

    // A bogus personId makes the second epicRequest.create fail (FK violation)
    // after the ticket + the first request were written in the same tx.
    await expect(
      reconcileDeactivationRequests(actor.id, [ok.id, "does-not-exist"], "Deactivate - batch"),
    ).rejects.toBeTruthy();

    // The ticket (created at the top of the tx) rolled back with the failed batch:
    // no orphan OPEN ticket, no partial request.
    expect(await prisma.ynhhTicket.count()).toBe(ticketsBefore);
    expect(await prisma.epicRequest.count({ where: { personId: ok.id } })).toBe(0);
  });
});

describe("submitEpicRequests", () => {
  beforeEach(resetDb);

  it("happy path: creates an OPEN ticket and SUBMITTED requests carrying the mirror Epic ID", async () => {
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const a = await createPerson("Alice");
    const b = await createPerson("Bob");

    const ticket = await submitEpicRequests(actor.id, "NEW", "New - Bulk - Alice, Bob", [
      { personId: a.id, mirrorEpicId: "MIRROR-A" },
      { personId: b.id, mirrorEpicId: null },
    ]);

    expect(ticket.status).toBe("OPEN");
    expect(ticket.description).toBe("New - Bulk - Alice, Bob");
    expect(ticket.submittedById).toBe(actor.id);

    const reqs = await prisma.epicRequest.findMany({ where: { ticketId: ticket.id }, orderBy: { person: { name: "asc" } } });
    expect(reqs).toHaveLength(2);
    expect(reqs.every((r) => r.status === "SUBMITTED" && r.kind === "NEW")).toBe(true);
    expect(reqs.find((r) => r.personId === a.id)?.mirrorEpicId).toBe("MIRROR-A");
    expect(reqs.find((r) => r.personId === b.id)?.mirrorEpicId).toBeNull();
  });

  it("rejects a duplicate open request and creates no ticket", async () => {
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const person = await createPerson("Alice");
    // An existing open (PENDING) request already tracks this person.
    await prisma.epicRequest.create({
      data: { personId: person.id, kind: "NEW", status: "PENDING", requestedById: actor.id },
    });

    // The open-request block is a recoverable conflict: a SupportConflictError
    // (a SupportStateError subclass) carrying the blocked person's name so the
    // caller can keep the generated artifacts and point at the Tracker.
    const err = await submitEpicRequests(actor.id, "NEW", "New - Individual - Alice", [
      { personId: person.id, mirrorEpicId: null },
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(SupportConflictError);
    expect(err).toBeInstanceOf(SupportStateError);
    expect((err as SupportConflictError).personNames).toEqual(["Alice"]);

    // The whole transaction rolls back: no new ticket, no second request.
    expect(await prisma.ynhhTicket.count()).toBe(0);
    expect(await prisma.epicRequest.count({ where: { personId: person.id } })).toBe(1);
  });

  it("rejects a NEW request for a person who already has an Epic ID, and creates no ticket", async () => {
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const person = await createPerson("Alice", { epicId: "E-EXISTS" });

    await expect(
      submitEpicRequests(actor.id, "NEW", "New - Individual - Alice", [
        { personId: person.id, mirrorEpicId: null },
      ])
    ).rejects.toBeInstanceOf(SupportStateError);

    expect(await prisma.ynhhTicket.count()).toBe(0);
    expect(await prisma.epicRequest.count()).toBe(0);
  });

  it("rejects a MODIFY/RENEW for a person with no Epic ID on file", async () => {
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const person = await createPerson("Alice");

    await expect(
      submitEpicRequests(actor.id, "MODIFY", "Modify - Individual - Alice", [
        { personId: person.id, mirrorEpicId: null },
      ])
    ).rejects.toBeInstanceOf(SupportStateError);

    expect(await prisma.ynhhTicket.count()).toBe(0);
  });

  it("rejects a non-active person", async () => {
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const person = await createPerson("Alice", { epicId: "E1", status: "OFFBOARDED" });

    await expect(
      submitEpicRequests(actor.id, "RENEW", "Renew - Individual - Alice", [
        { personId: person.id, mirrorEpicId: null },
      ])
    ).rejects.toBeInstanceOf(SupportStateError);

    expect(await prisma.ynhhTicket.count()).toBe(0);
  });

  it("throws SupportNotFoundError when a person no longer exists", async () => {
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");

    await expect(
      submitEpicRequests(actor.id, "NEW", "New - Individual - Ghost", [
        { personId: "cld_nonexistent", mirrorEpicId: null },
      ])
    ).rejects.toBeInstanceOf(SupportNotFoundError);

    expect(await prisma.ynhhTicket.count()).toBe(0);
  });
});

describe("logYnhhIncident", () => {
  beforeEach(resetDb);

  it("rejects a non-manager", async () => {
    const actor = await createPerson("Actor");
    await expect(
      logYnhhIncident(actor.id, { subject: "Portal outage" })
    ).rejects.toThrow(SupportForbiddenError);
  });

  it("creates a standalone OPEN ticket with the subject, linked person, and SR#, with no linked requests", async () => {
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const about = await createPerson("Concerned Party");

    const ticket = await logYnhhIncident(mgr.id, {
      subject: "Cannot access Epic portal",
      description: "User reports a blank screen on login.",
      serviceRequestNumber: "SR-1001",
      personId: about.id,
    });

    expect(ticket.subject).toBe("Cannot access Epic portal");
    expect(ticket.description).toBe("User reports a blank screen on login.");
    expect(ticket.serviceRequestNumber).toBe("SR-1001");
    expect(ticket.personId).toBe(about.id);
    expect(ticket.status).toBe("OPEN");
    expect(ticket.submittedById).toBe(mgr.id);

    const requests = await prisma.epicRequest.findMany({ where: { ticketId: ticket.id } });
    expect(requests).toHaveLength(0);
  });

  it("rejects a blank subject", async () => {
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    await expect(
      logYnhhIncident(mgr.id, { subject: "   " })
    ).rejects.toThrow(SupportStateError);
  });
});

describe("resolveIncident", () => {
  beforeEach(resetDb);

  it("sets CLOSED, resolution, and closedAt", async () => {
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const ticket = await logYnhhIncident(mgr.id, { subject: "Password reset needed" });

    await resolveIncident(mgr.id, ticket.id, "Reset via YNHH help desk.");

    const updated = await prisma.ynhhTicket.findUnique({ where: { id: ticket.id } });
    expect(updated?.status).toBe("CLOSED");
    expect(updated?.resolution).toBe("Reset via YNHH help desk.");
    expect(updated?.closedAt).not.toBeNull();
  });

  it("rejects an already-closed ticket", async () => {
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const ticket = await logYnhhIncident(mgr.id, { subject: "Already handled" });
    await resolveIncident(mgr.id, ticket.id, "Done.");

    await expect(
      resolveIncident(mgr.id, ticket.id, "Again.")
    ).rejects.toThrow(SupportStateError);
  });

  it("requires MANAGE", async () => {
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const nonMgr = await createPerson("NonManager");
    const ticket = await logYnhhIncident(mgr.id, { subject: "Needs a manager" });

    await expect(
      resolveIncident(nonMgr.id, ticket.id, "Trying anyway.")
    ).rejects.toThrow(SupportForbiddenError);
  });

  it("throws SupportNotFoundError for a missing ticket", async () => {
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    await expect(
      resolveIncident(mgr.id, "nonexistent-id", "Resolution")
    ).rejects.toThrow(SupportNotFoundError);
  });
});

describe("getEpicRequestHistory with incidents", () => {
  beforeEach(resetDb);

  it("returns a logged incident with ticket.subject, about.name, and attachments; Epic-batch tickets have subject=null/about=null", async () => {
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const about = await createPerson("Affected Person");

    const incident = await logYnhhIncident(mgr.id, {
      subject: "Locked out of Epic",
      personId: about.id,
    });
    await persistAttachment(mgr.id, { ynhhTicketId: incident.id }, {
      fileName: "screenshot.png",
      mimeType: "image/png",
      bytes: Buffer.from("bytes"),
    });

    // A plain Epic-batch ticket (no subject/person), matching existing usage.
    const epicSubject = await createPerson("Epic Subject", { epicId: "E1" });
    const batchTicket = await prisma.ynhhTicket.create({
      data: { submittedById: mgr.id, status: "OPEN", serviceRequestNumber: "SR-2000" },
    });
    await prisma.epicRequest.create({
      data: { personId: epicSubject.id, kind: "NEW", status: "SUBMITTED", ticketId: batchTicket.id, requestedById: mgr.id },
    });

    const rows = await getEpicRequestHistory();
    expect(rows).toHaveLength(2);

    const incidentRow = rows.find((r) => r.ticket.id === incident.id)!;
    expect(incidentRow.ticket.subject).toBe("Locked out of Epic");
    expect(incidentRow.about).toEqual({ name: "Affected Person" });
    expect(incidentRow.attachments).toHaveLength(1);
    expect(incidentRow.attachments[0].filename).toBe("screenshot.png");
    expect(incidentRow.requests).toHaveLength(0);

    const batchRow = rows.find((r) => r.ticket.id === batchTicket.id)!;
    expect(batchRow.ticket.subject).toBeNull();
    expect(batchRow.about).toBeNull();
    expect(batchRow.attachments).toEqual([]);
    expect(batchRow.requests).toHaveLength(1);
  });
});

describe("listIncidentPeople", () => {
  beforeEach(resetDb);

  it("returns only ACTIVE people, ordered by name", async () => {
    await createPerson("Zed Active", { status: "ACTIVE" });
    await createPerson("Amy Active", { status: "ACTIVE" });
    await createPerson("Offboarded Person", { status: "OFFBOARDED" });

    const rows = await listIncidentPeople();
    expect(rows.map((r) => r.name)).toEqual(["Amy Active", "Zed Active"]);
  });
});
