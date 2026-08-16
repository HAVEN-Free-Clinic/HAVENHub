/**
 * TDD tests for epic-ticket-sync.ts: the Epic-request-driven TechRequest.status
 * sync.
 *
 * onEpicSubmitted(actorPersonId, ynhhTicketId):
 *   - Moves every linked TechRequest among the ticket's requests to AWAITING_YNHH.
 *   - Fires the Direction 3 Intercom ticket-state push (via setStatus) for a
 *     ticket linked to an Intercom Ticket.
 *   - Posts the Epic-specific detail note for a ticket linked to an Intercom
 *     conversation, naming the request and the YNHH ticket.
 *   - Does not call Intercom at all for an unlinked ticket.
 *   - Skips a request with no techRequestId (nothing to move).
 *   - Leaves a terminal TechRequest alone.
 *   - Groups multiple requests attached to the SAME TechRequest into one
 *     transition and one note.
 *
 * onEpicResolved(actorPersonId, epicRequestId, outcome):
 *   - No-ops when the request has no techRequestId.
 *   - No-ops when the linked TechRequest is not currently AWAITING_YNHH.
 *   - Does NOT move the ticket back while a sibling request is still SUBMITTED
 *     (the 0..n case).
 *   - Moves the ticket back to IN_PROGRESS once the last outstanding request
 *     resolves (COMPLETED or CANCELLED alike) -- never to RESOLVED.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { intercomStateId, intercomWriteCalls, stubIntercomFetch } from "@/platform/test/intercom";
import { createTechRequest } from "./tech-request";
import {
  onEpicSubmitted,
  onEpicResolved,
  syncYnhhServiceRequestToIntercom,
} from "./epic-ticket-sync";

// ---------------------------------------------------------------------------
// Helpers (copied from epic.test.ts / manage.test.ts)
// ---------------------------------------------------------------------------

async function createPerson(name: string, opts: { epicId?: string } = {}) {
  return prisma.person.create({ data: { name, epicId: opts.epicId ?? null } });
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

async function linkToTicket(techRequestId: string, intercomId: string) {
  return prisma.techRequest.update({
    where: { id: techRequestId },
    data: { intercomConversationId: intercomId, intercomTicketId: intercomId },
  });
}

async function createYnhhTicket(actorId: string, serviceRequestNumber: string | null = null) {
  return prisma.ynhhTicket.create({
    data: { status: "OPEN", submittedById: actorId, serviceRequestNumber },
  });
}

async function submittedEpicRequest(
  personId: string,
  requestedById: string,
  ticketId: string,
  techRequestId: string | null,
  kind: "NEW" | "MODIFY" | "RENEW" | "DEACTIVATE" = "NEW"
) {
  return prisma.epicRequest.create({
    data: { personId, requestedById, kind, status: "SUBMITTED", ticketId, techRequestId },
  });
}

function mockFetchOk() {
  // Answers GET /ticket_states as well: an outbound state push resolves the
  // label to a state id there before writing. See @/platform/test/intercom.
  stubIntercomFetch();
}

beforeEach(resetDb);

describe("onEpicSubmitted", () => {
  beforeEach(() => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
    vi.stubEnv("INTERCOM_BOT_ADMIN_ID", "admin-1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("moves the linked TechRequest to AWAITING_YNHH and pushes the Intercom ticket state", async () => {
    mockFetchOk();
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const requester = await createPerson("Requester");
    const target = await createPerson("Alice");

    const techRequest = await createTechRequest(requester.id, {
      category: "EPIC",
      subject: "Epic access",
      description: "d",
    });
    await linkToTicket(techRequest.id, "conv_1");

    const ticket = await createYnhhTicket(actor.id);
    await submittedEpicRequest(target.id, actor.id, ticket.id, techRequest.id);

    await onEpicSubmitted(actor.id, ticket.id);

    const updated = await prisma.techRequest.findUniqueOrThrow({ where: { id: techRequest.id } });
    expect(updated.status).toBe("AWAITING_YNHH");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const ticketStateCalls = (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) =>
      url.includes("/tickets/")
    );
    expect(ticketStateCalls).toHaveLength(1);
    const body = JSON.parse(ticketStateCalls[0][1].body as string) as Record<string, unknown>;
    // The id of ops' workspace state, resolved from ops' own label rather than
    // from the Hub's "Awaiting YNHH" status label -- see intercom-sync.ts on why
    // the two vocabularies are kept separate.
    expect(body).toEqual({ ticket_state_id: intercomStateId("Waiting on YNHH ITS") });
  });

  it("posts a note naming the Epic request and the YNHH ticket into the linked conversation", async () => {
    mockFetchOk();
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const requester = await createPerson("Requester");
    const target = await createPerson("Alice");

    const techRequest = await createTechRequest(requester.id, {
      category: "EPIC",
      subject: "Epic access",
      description: "d",
    });
    await linkToTicket(techRequest.id, "conv_1");

    const ticket = await createYnhhTicket(actor.id, "SR-4242");
    await submittedEpicRequest(target.id, actor.id, ticket.id, techRequest.id, "NEW");

    await onEpicSubmitted(actor.id, ticket.id);

    // Filtered by endpoint path, not by id: linkToTicket sets
    // intercomConversationId and intercomTicketId to the same value, so a
    // substring match on the id would also catch the Direction 3 ticket-state
    // push. setStatus's own Direction 2 sync also posts a generic status note
    // into the same conversation, so this looks for OUR note among however
    // many conversation posts landed, rather than assuming there is only one.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const noteCalls = (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) => url.includes("/conversations/"));
    const bodies = noteCalls.map(([, init]) => (JSON.parse(init.body as string) as { body: string }).body);
    expect(bodies.some((b) => b.includes("Alice") && b.includes("SR-4242"))).toBe(true);
  });

  it("does not call Intercom at all for an unlinked TechRequest", async () => {
    mockFetchOk();
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const requester = await createPerson("Requester");
    const target = await createPerson("Alice");

    const techRequest = await createTechRequest(requester.id, {
      category: "EPIC",
      subject: "Epic access",
      description: "d",
    });

    const ticket = await createYnhhTicket(actor.id);
    await submittedEpicRequest(target.id, actor.id, ticket.id, techRequest.id);

    await onEpicSubmitted(actor.id, ticket.id);

    const updated = await prisma.techRequest.findUniqueOrThrow({ where: { id: techRequest.id } });
    expect(updated.status).toBe("AWAITING_YNHH");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips a request with no techRequestId -- nothing to move", async () => {
    mockFetchOk();
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const target = await createPerson("Alice");

    const ticket = await createYnhhTicket(actor.id);
    await submittedEpicRequest(target.id, actor.id, ticket.id, null);

    await expect(onEpicSubmitted(actor.id, ticket.id)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves a terminal TechRequest alone rather than resurrecting it to AWAITING_YNHH", async () => {
    mockFetchOk();
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const requester = await createPerson("Requester");
    const target = await createPerson("Alice");

    const techRequest = await createTechRequest(requester.id, {
      category: "EPIC",
      subject: "Epic access",
      description: "d",
    });
    await prisma.techRequest.update({ where: { id: techRequest.id }, data: { status: "CLOSED" } });

    const ticket = await createYnhhTicket(actor.id);
    await submittedEpicRequest(target.id, actor.id, ticket.id, techRequest.id);

    await onEpicSubmitted(actor.id, ticket.id);

    const updated = await prisma.techRequest.findUniqueOrThrow({ where: { id: techRequest.id } });
    expect(updated.status).toBe("CLOSED");
  });

  it("groups multiple requests attached to the same TechRequest into one transition and one combined note", async () => {
    mockFetchOk();
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const requester = await createPerson("Requester");
    const alice = await createPerson("Alice");
    const bob = await createPerson("Bob");

    const techRequest = await createTechRequest(requester.id, {
      category: "EPIC",
      subject: "Epic access",
      description: "d",
    });
    await linkToTicket(techRequest.id, "conv_1");

    const ticket = await createYnhhTicket(actor.id);
    await submittedEpicRequest(alice.id, actor.id, ticket.id, techRequest.id, "NEW");
    await submittedEpicRequest(bob.id, actor.id, ticket.id, techRequest.id, "RENEW");

    await onEpicSubmitted(actor.id, ticket.id);

    // Same id-collision caveat as the test above: filter by endpoint path, and
    // look for a single note body naming BOTH people (one combined note, not
    // one per request) among whichever conversation posts landed.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const noteCalls = (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) => url.includes("/conversations/"));
    const bodies = noteCalls.map(([, init]) => (JSON.parse(init.body as string) as { body: string }).body);
    expect(bodies.some((b) => b.includes("Alice") && b.includes("Bob"))).toBe(true);
  });
});

describe("onEpicResolved", () => {
  beforeEach(() => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
    vi.stubEnv("INTERCOM_BOT_ADMIN_ID", "admin-1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("no-ops when the request has no techRequestId", async () => {
    mockFetchOk();
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const target = await createPerson("Alice");
    const ticket = await createYnhhTicket(actor.id);
    const req = await submittedEpicRequest(target.id, actor.id, ticket.id, null);
    await prisma.epicRequest.update({ where: { id: req.id }, data: { status: "COMPLETED" } });

    await expect(onEpicResolved(actor.id, req.id, "COMPLETED")).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("no-ops when the linked TechRequest is not currently AWAITING_YNHH", async () => {
    mockFetchOk();
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const requester = await createPerson("Requester");
    const target = await createPerson("Alice");

    // IN_PROGRESS, never moved to AWAITING_YNHH.
    const techRequest = await createTechRequest(requester.id, {
      category: "EPIC",
      subject: "Epic access",
      description: "d",
    });
    await prisma.techRequest.update({ where: { id: techRequest.id }, data: { status: "IN_PROGRESS" } });

    const ticket = await createYnhhTicket(actor.id);
    const req = await submittedEpicRequest(target.id, actor.id, ticket.id, techRequest.id);
    await prisma.epicRequest.update({ where: { id: req.id }, data: { status: "COMPLETED" } });

    await onEpicResolved(actor.id, req.id, "COMPLETED");

    const updated = await prisma.techRequest.findUniqueOrThrow({ where: { id: techRequest.id } });
    expect(updated.status).toBe("IN_PROGRESS");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does NOT move the ticket back while a sibling request is still SUBMITTED (the 0..n case)", async () => {
    mockFetchOk();
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const requester = await createPerson("Requester");
    const alice = await createPerson("Alice");
    const bob = await createPerson("Bob");

    const techRequest = await createTechRequest(requester.id, {
      category: "EPIC",
      subject: "Epic access",
      description: "d",
    });
    await prisma.techRequest.update({ where: { id: techRequest.id }, data: { status: "AWAITING_YNHH" } });

    const ticket = await createYnhhTicket(actor.id);
    const aliceReq = await submittedEpicRequest(alice.id, actor.id, ticket.id, techRequest.id, "NEW");
    await submittedEpicRequest(bob.id, actor.id, ticket.id, techRequest.id, "RENEW"); // still SUBMITTED

    await prisma.epicRequest.update({ where: { id: aliceReq.id }, data: { status: "COMPLETED" } });
    await onEpicResolved(actor.id, aliceReq.id, "COMPLETED");

    const updated = await prisma.techRequest.findUniqueOrThrow({ where: { id: techRequest.id } });
    expect(updated.status).toBe("AWAITING_YNHH");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("moves the ticket back to IN_PROGRESS once the last outstanding request completes -- never to RESOLVED", async () => {
    mockFetchOk();
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const requester = await createPerson("Requester");
    const alice = await createPerson("Alice");

    const techRequest = await createTechRequest(requester.id, {
      category: "EPIC",
      subject: "Epic access",
      description: "d",
    });
    await linkToTicket(techRequest.id, "conv_1");
    await prisma.techRequest.update({ where: { id: techRequest.id }, data: { status: "AWAITING_YNHH" } });

    const ticket = await createYnhhTicket(actor.id, "SR-1010");
    const aliceReq = await submittedEpicRequest(alice.id, actor.id, ticket.id, techRequest.id, "NEW");

    await prisma.epicRequest.update({ where: { id: aliceReq.id }, data: { status: "COMPLETED" } });
    await onEpicResolved(actor.id, aliceReq.id, "COMPLETED");

    const updated = await prisma.techRequest.findUniqueOrThrow({ where: { id: techRequest.id } });
    expect(updated.status).toBe("IN_PROGRESS");
    expect(updated.status).not.toBe("RESOLVED");

    // Filtered by endpoint path (see the onEpicSubmitted tests' matching
    // comment): linkToTicket sets intercomConversationId and intercomTicketId
    // to the same id, so a substring match on the id would also catch the
    // Direction 3 ticket-state push, whose body has no `.body` field.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const noteCalls = (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) => url.includes("/conversations/"));
    const bodies = noteCalls.map(([, init]) => (JSON.parse(init.body as string) as { body: string }).body);
    expect(bodies.some((b) => b.includes("Alice") && b.includes("SR-1010"))).toBe(true);
  });

  it("moves the ticket back to IN_PROGRESS on the last request being CANCELLED too", async () => {
    mockFetchOk();
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const requester = await createPerson("Requester");
    const alice = await createPerson("Alice");

    const techRequest = await createTechRequest(requester.id, {
      category: "EPIC",
      subject: "Epic access",
      description: "d",
    });
    await prisma.techRequest.update({ where: { id: techRequest.id }, data: { status: "AWAITING_YNHH" } });

    const ticket = await createYnhhTicket(actor.id);
    const aliceReq = await submittedEpicRequest(alice.id, actor.id, ticket.id, techRequest.id, "NEW");

    await prisma.epicRequest.update({ where: { id: aliceReq.id }, data: { status: "CANCELLED" } });
    await onEpicResolved(actor.id, aliceReq.id, "CANCELLED");

    const updated = await prisma.techRequest.findUniqueOrThrow({ where: { id: techRequest.id } });
    expect(updated.status).toBe("IN_PROGRESS");
  });
});

// ---------------------------------------------------------------------------
// syncYnhhServiceRequestToIntercom
// ---------------------------------------------------------------------------

/**
 * The RITM is issued by YNHH IT AFTER the ticket is opened, so it is normally
 * recorded later. Until this existed, recording it wrote a column and told
 * nobody: the Intercom ticket an agent was looking at still said the request
 * had gone to YNHH with no number.
 */
describe("syncYnhhServiceRequestToIntercom", () => {
  beforeEach(() => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
    vi.stubEnv("INTERCOM_BOT_ADMIN_ID", "admin-1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function seedLinked(
    serviceRequestNumber: string | null,
    status: "AWAITING_YNHH" | "RESOLVED" = "AWAITING_YNHH"
  ) {
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const requester = await createPerson("Requester");
    const alice = await createPerson("Alice");

    const techRequest = await createTechRequest(requester.id, {
      category: "EPIC",
      subject: "Epic access",
      description: "d",
    });
    await linkToTicket(techRequest.id, "conv_1");
    await prisma.techRequest.update({ where: { id: techRequest.id }, data: { status } });

    const ticket = await createYnhhTicket(actor.id, serviceRequestNumber);
    await submittedEpicRequest(alice.id, actor.id, ticket.id, techRequest.id, "NEW");
    return { actor, ticket, techRequest };
  }

  it("writes the number onto the linked Intercom ticket's attribute", async () => {
    const fetchMock = stubIntercomFetch();
    const { ticket } = await seedLinked("RITM0345759");

    await syncYnhhServiceRequestToIntercom(ticket.id);

    const attributeWrites = intercomWriteCalls(fetchMock)
      .filter(([url]) => url.includes("/tickets/"))
      .map(([, init]) => JSON.parse(init.body as string) as Record<string, unknown>)
      .filter((b) => "ticket_attributes" in b);
    expect(attributeWrites).toEqual([
      { ticket_attributes: { "YNHH service request": "RITM0345759" } },
    ]);
  });

  // The note is the durable record, and the fallback for a workspace where the
  // ticket attribute was never created.
  it("posts a staff note carrying the number", async () => {
    const fetchMock = stubIntercomFetch();
    const { ticket } = await seedLinked("RITM0345759");

    await syncYnhhServiceRequestToIntercom(ticket.id);

    const notes = intercomWriteCalls(fetchMock)
      .filter(([url]) => url.includes("/conversations/"))
      .map(([, init]) => (JSON.parse(init.body as string) as { body: string }).body);
    expect(notes.some((b) => b.includes("RITM0345759"))).toBe(true);
  });

  it("does nothing when the YNHH ticket has no number yet", async () => {
    const fetchMock = stubIntercomFetch();
    const { ticket } = await seedLinked(null);

    await syncYnhhServiceRequestToIntercom(ticket.id);

    expect(intercomWriteCalls(fetchMock)).toHaveLength(0);
  });

  // Closed out for reasons independent of the Epic request; an attribute write
  // would misreport it as live YNHH work.
  it("skips a TechRequest in a terminal status", async () => {
    const fetchMock = stubIntercomFetch();
    const { ticket } = await seedLinked("RITM0345759", "RESOLVED");

    await syncYnhhServiceRequestToIntercom(ticket.id);

    expect(intercomWriteCalls(fetchMock)).toHaveLength(0);
  });

  it("does not call Intercom for an Epic request attached to no support ticket", async () => {
    const fetchMock = stubIntercomFetch();
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const alice = await createPerson("Alice");
    const ticket = await createYnhhTicket(actor.id, "RITM0345759");
    await submittedEpicRequest(alice.id, actor.id, ticket.id, null, "NEW");

    await syncYnhhServiceRequestToIntercom(ticket.id);

    expect(intercomWriteCalls(fetchMock)).toHaveLength(0);
  });

  // Two Epic requests on one YNHH ticket can point at the same support ticket;
  // it must not be written twice.
  it("writes once per linked support ticket, not once per Epic request", async () => {
    const fetchMock = stubIntercomFetch();
    const { actor, ticket, techRequest } = await seedLinked("RITM0345759");
    const bob = await createPerson("Bob");
    await submittedEpicRequest(bob.id, actor.id, ticket.id, techRequest.id, "MODIFY");

    await syncYnhhServiceRequestToIntercom(ticket.id);

    const attributeWrites = intercomWriteCalls(fetchMock).filter(([url]) => url.includes("/tickets/"));
    expect(attributeWrites).toHaveLength(1);
  });
});
