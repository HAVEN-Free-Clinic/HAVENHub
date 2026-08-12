/**
 * TDD tests for the support module manager-action service.
 *
 * assignRequest, setStatus, setPriority, resolveRequest, cancelRequest all
 * require support.manage_requests. cancelOwnRequest does not (self-service,
 * gated instead on requesterId === actor).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createTechRequest, SupportNotFoundError, SupportStateError } from "./tech-request";
import {
  assignRequest,
  setStatus,
  setPriority,
  resolveRequest,
  cancelRequest,
  cancelOwnRequest,
} from "./manage";

// ---------------------------------------------------------------------------
// Helpers (copied from src/modules/volunteers/services/epic.test.ts)
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

/** Only createTechRequestFromConversation sets this in production; tests link a Hub-form ticket directly. */
async function linkToConversation(id: string, conversationId: string) {
  return prisma.techRequest.update({ where: { id }, data: { intercomConversationId: conversationId } });
}

/**
 * Links both Intercom ids, matching how a real Ticket is created (same value
 * for both -- see the design doc's Direction 1 note). Only tests that
 * exercise the Direction 3 outward Ticket-state push need this; the plain
 * linkToConversation above is enough for Direction 2's note-only tests.
 */
async function linkToTicket(id: string, ticketId: string) {
  return prisma.techRequest.update({
    where: { id },
    data: { intercomConversationId: ticketId, intercomTicketId: ticketId },
  });
}

beforeEach(resetDb);

describe("assignRequest", () => {
  it("requires the manage permission", async () => {
    const p = await createPerson("Alice");
    const req = await createTechRequest(p.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(assignRequest(p.id, req.id, p.id)).rejects.toThrow(/permission/i);
  });

  // Assignment notifications were removed: managers work tickets in Intercom's
  // inbox, which shows and notifies assignment natively. Asserted as "no email
  // at all" rather than by dropping the old test, because the failure mode being
  // guarded is a well-meaning restoration of the notify() call -- which would
  // put Hub-authored support mail back in a member-adjacent channel that this
  // whole stack moved to Intercom.
  it("sets assignedToId and emails nobody", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Marla Manager", { contactEmail: "mgr@example.com" });
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    const updated = await assignRequest(mgr.id, req.id, mgr.id);
    expect(updated.assignedToId).toBe(mgr.id);

    const logs = await prisma.emailLog.findMany({ where: { toEmail: "mgr@example.com" } });
    expect(logs).toHaveLength(0);
  });

  it("refuses to assign to a person who is not a support manager (audit #26)", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Marla Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const notManager = await createPerson("Not A Manager");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await expect(assignRequest(mgr.id, req.id, notManager.id)).rejects.toThrow(SupportStateError);
    const fresh = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(fresh.assignedToId).toBeNull();
  });

  it("unassigns when given null", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Marla Manager", { contactEmail: "mgr@example.com" });
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await assignRequest(mgr.id, req.id, mgr.id);

    const updated = await assignRequest(mgr.id, req.id, null);
    expect(updated.assignedToId).toBeNull();

    const logs = await prisma.emailLog.findMany({ where: { toEmail: "mgr@example.com" } });
    expect(logs).toHaveLength(0);
  });

  it("refuses to reassign a resolved (terminal) ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await resolveRequest(mgr.id, req.id, "Reset the account.");

    await expect(assignRequest(mgr.id, req.id, mgr.id)).rejects.toThrow(SupportStateError);
  });
});

describe("setStatus", () => {
  it("requires the manage permission", async () => {
    const p = await createPerson("Alice");
    const req = await createTechRequest(p.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(setStatus(p.id, req.id, "IN_PROGRESS")).rejects.toThrow(/permission/i);
  });

  it("updates status and notifies the requester on AWAITING_REQUESTER", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    const updated = await setStatus(mgr.id, req.id, "AWAITING_REQUESTER");
    expect(updated.status).toBe("AWAITING_REQUESTER");

    const logs = await prisma.emailLog.findMany({ where: { template: "support.status_changed" } });
    expect(logs.map((l) => l.toEmail)).toContain("owner@example.com");
  });

  it("notifies the requester on any status transition (e.g. IN_PROGRESS)", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await setStatus(mgr.id, req.id, "IN_PROGRESS");

    const logs = await prisma.emailLog.findMany({ where: { template: "support.status_changed" } });
    expect(logs.map((l) => l.toEmail)).toContain("owner@example.com");
  });

  it("notifies on AWAITING_YNHH and CLOSED transitions too", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await setStatus(mgr.id, req.id, "AWAITING_YNHH");
    await setStatus(mgr.id, req.id, "CLOSED");

    const logs = await prisma.emailLog.findMany({ where: { template: "support.status_changed" } });
    expect(logs).toHaveLength(2);
  });

  it("does not notify on a no-op (same-status) call", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    // Fresh tickets start SUBMITTED; re-setting SUBMITTED is not a transition.
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await setStatus(mgr.id, req.id, "SUBMITTED");

    const logs = await prisma.emailLog.findMany({ where: { template: "support.status_changed" } });
    expect(logs).toHaveLength(0);
  });

  it("blocks transitions out of a terminal state", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await cancelRequest(mgr.id, req.id, "No longer needed.");

    await expect(setStatus(mgr.id, req.id, "IN_PROGRESS")).rejects.toThrow();
  });

  it("rejects RESOLVED as a target status -- must go through resolveRequest", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await expect(setStatus(mgr.id, req.id, "RESOLVED")).rejects.toThrow(SupportStateError);

    const after = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).not.toBe("RESOLVED");
    expect(after.resolvedAt).toBeNull();
    expect(after.resolution).toBeNull();
  });

  it("rejects CANCELLED as a target status -- must go through cancelRequest", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await expect(setStatus(mgr.id, req.id, "CANCELLED")).rejects.toThrow(SupportStateError);

    const after = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).not.toBe("CANCELLED");
  });

  it("still allows CLOSED as a direct transition", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    const updated = await setStatus(mgr.id, req.id, "CLOSED");
    expect(updated.status).toBe("CLOSED");
  });
});

describe("setPriority", () => {
  it("requires the manage permission", async () => {
    const p = await createPerson("Alice");
    const req = await createTechRequest(p.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(setPriority(p.id, req.id, "HIGH")).rejects.toThrow(/permission/i);
  });

  it("updates priority", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    const updated = await setPriority(mgr.id, req.id, "CRITICAL");
    expect(updated.priority).toBe("CRITICAL");
  });

  it("refuses to change priority on a resolved (terminal) ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await resolveRequest(mgr.id, req.id, "Reset the account.");

    await expect(setPriority(mgr.id, req.id, "CRITICAL")).rejects.toThrow(SupportStateError);
  });
});

describe("resolveRequest", () => {
  it("sets RESOLVED with resolvedAt and a resolution", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await resolveRequest(mgr.id, req.id, "Reset the account.");
    const after = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe("RESOLVED");
    expect(after.resolvedAt).not.toBeNull();
    expect(after.resolution).toBe("Reset the account.");
  });

  it("notifies the requester", async () => {
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await resolveRequest(mgr.id, req.id, "Reset the account.");

    const logs = await prisma.emailLog.findMany({ where: { template: "support.request_resolved" } });
    expect(logs.map((l) => l.toEmail)).toContain("owner@example.com");
  });

  it("rejects a blank resolution", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await expect(resolveRequest(mgr.id, req.id, "   ")).rejects.toThrow(/resolution/i);
  });
});

describe("cancelRequest", () => {
  it("requires the manage permission", async () => {
    const p = await createPerson("Alice");
    const req = await createTechRequest(p.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(cancelRequest(p.id, req.id, "no longer needed")).rejects.toThrow(/permission/i);
  });

  it("cancels a non-terminal ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    const updated = await cancelRequest(mgr.id, req.id, "Duplicate ticket.");
    expect(updated.status).toBe("CANCELLED");
  });

  it("rejects cancelling an already-terminal ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await cancelRequest(mgr.id, req.id, "Duplicate ticket.");

    await expect(cancelRequest(mgr.id, req.id, "Again.")).rejects.toThrow();
  });
});

describe("cancelOwnRequest", () => {
  it("lets the owner cancel their own open ticket", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await cancelOwnRequest(owner.id, req.id);
    const after = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe("CANCELLED");
  });

  it("does not require the manage permission", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    // No grantPermission call at all -- should still succeed.
    await expect(cancelOwnRequest(owner.id, req.id)).resolves.toBeDefined();
  });

  it("refuses to cancel someone else's ticket", async () => {
    const owner = await createPerson("Owner");
    const stranger = await createPerson("Stranger");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(cancelOwnRequest(stranger.id, req.id)).rejects.toThrow(SupportNotFoundError);
  });

  it("rejects cancelling an already-terminal ticket", async () => {
    const owner = await createPerson("Owner");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await cancelOwnRequest(owner.id, req.id);
    await expect(cancelOwnRequest(owner.id, req.id)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Outbound Intercom sync: setStatus/resolveRequest on a ticket linked to a
// conversation post there instead of emailing the requester. See
// docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md,
// Direction 2.
// ---------------------------------------------------------------------------

function mockFetchOk() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
}

describe("outbound Intercom sync", () => {
  beforeEach(() => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
    vi.stubEnv("INTERCOM_BOT_ADMIN_ID", "admin-1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("setStatus posts to Intercom for a linked ticket and sends no email", async () => {
    mockFetchOk();
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await linkToConversation(req.id, "conv_1");

    await setStatus(mgr.id, req.id, "IN_PROGRESS");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("conv_1");
    const logs = await prisma.emailLog.findMany({ where: { template: "support.status_changed" } });
    expect(logs).toHaveLength(0);
  });

  it("setStatus does not call Intercom for an unlinked ticket and still emails as before", async () => {
    mockFetchOk();
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await setStatus(mgr.id, req.id, "IN_PROGRESS");

    expect(fetch).not.toHaveBeenCalled();
    const logs = await prisma.emailLog.findMany({ where: { template: "support.status_changed" } });
    expect(logs.map((l) => l.toEmail)).toContain("owner@example.com");
  });

  it("AWAITING_YNHH posts wording that names YNHH", async () => {
    mockFetchOk();
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await linkToConversation(req.id, "conv_1");

    await setStatus(mgr.id, req.id, "AWAITING_YNHH");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { body: string };
    expect(body.body).toMatch(/Yale New Haven Health|YNHH/);
  });

  it("resolveRequest posts the resolution text to Intercom for a linked ticket and sends no email", async () => {
    mockFetchOk();
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await linkToConversation(req.id, "conv_1");

    await resolveRequest(mgr.id, req.id, "Reset the WiFi adapter driver.");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { body: string };
    expect(body.body).toContain("Reset the WiFi adapter driver.");
    const logs = await prisma.emailLog.findMany({ where: { template: "support.request_resolved" } });
    expect(logs).toHaveLength(0);
  });

  it("commits the status change even when Intercom is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await linkToConversation(req.id, "conv_1");

    const updated = await setStatus(mgr.id, req.id, "IN_PROGRESS");

    expect(updated.status).toBe("IN_PROGRESS");
    const after = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe("IN_PROGRESS");
  });

  it("commits a resolve even when Intercom is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await linkToConversation(req.id, "conv_1");

    const updated = await resolveRequest(mgr.id, req.id, "Reset the account.");

    expect(updated.status).toBe("RESOLVED");
    expect(updated.resolution).toBe("Reset the account.");
  });

  it("never includes an INTERNAL comment's content in the Intercom payload", async () => {
    mockFetchOk();
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await linkToConversation(req.id, "conv_1");
    await prisma.techRequestComment.create({
      data: {
        requestId: req.id,
        authorId: mgr.id,
        body: "INTERNAL-ONLY: escalation contact is the VP of IT.",
        visibility: "INTERNAL",
      },
    });
    await prisma.techRequestComment.create({
      data: {
        requestId: req.id,
        authorId: mgr.id,
        body: "PUBLIC-VISIBLE: we are looking into this.",
        visibility: "PUBLIC",
      },
    });

    await resolveRequest(mgr.id, req.id, "Reset the account.");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const raw = init.body as string;
    expect(raw).not.toContain("INTERNAL-ONLY");
    expect(raw).not.toContain("escalation contact");
  });
});

// ---------------------------------------------------------------------------
// Outbound Intercom sync (Direction 3, Hub-origin half): every
// status-changing action here pushes the new status onto the linked
// Intercom TICKET's own state (a different object from the conversation the
// "outbound Intercom sync" tests above post a note into). See
// docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md,
// Direction 3, and notifications.ts's pushIntercomTicketState.
// ---------------------------------------------------------------------------

describe("outbound Intercom ticket-state sync", () => {
  beforeEach(() => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
    vi.stubEnv("INTERCOM_BOT_ADMIN_ID", "admin-1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function ticketStateCalls(): [string, RequestInit][] {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    return (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) => url.includes("/tickets/"));
  }

  it("setStatus pushes the mapped state onto the linked Intercom ticket", async () => {
    mockFetchOk();
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await linkToTicket(req.id, "ticket_1");

    await setStatus(mgr.id, req.id, "IN_PROGRESS");

    const calls = ticketStateCalls();
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toContain("ticket_1");
    const body = JSON.parse(init.body as string) as { state: string };
    expect(body.state).toBe("In progress");
  });

  it("resolveRequest pushes the RESOLVED state onto the linked Intercom ticket", async () => {
    mockFetchOk();
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await linkToTicket(req.id, "ticket_1");

    await resolveRequest(mgr.id, req.id, "Reset the account.");

    const calls = ticketStateCalls();
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0][1].body as string) as { state: string };
    expect(body.state).toBe("Resolved");
  });

  it("cancelRequest pushes the CANCELLED state onto the linked Intercom ticket", async () => {
    mockFetchOk();
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await linkToTicket(req.id, "ticket_1");

    await cancelRequest(mgr.id, req.id, "Duplicate ticket.");

    const calls = ticketStateCalls();
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0][1].body as string) as { state: string };
    expect(body.state).toBe("Cancelled");
  });

  it("writes nothing to /tickets/ for a ticket with no intercomTicketId, even when linked to a conversation", async () => {
    mockFetchOk();
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await linkToConversation(req.id, "conv_1");

    await setStatus(mgr.id, req.id, "IN_PROGRESS");

    expect(ticketStateCalls()).toHaveLength(0);
  });

  it("writes nothing for a TechRequest with no Intercom link at all", async () => {
    mockFetchOk();
    const owner = await createPerson("Owner", { contactEmail: "owner@example.com" });
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });

    await setStatus(mgr.id, req.id, "IN_PROGRESS");

    expect(ticketStateCalls()).toHaveLength(0);
  });

  it("writes nothing on a no-op (same-status) call, since manage.ts never even reaches the push for a no-op", async () => {
    mockFetchOk();
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await linkToTicket(req.id, "ticket_1");

    // Fresh tickets start SUBMITTED; re-setting SUBMITTED is not a transition.
    await setStatus(mgr.id, req.id, "SUBMITTED");

    expect(ticketStateCalls()).toHaveLength(0);
  });

  it("commits the status change even when the Intercom ticket-state push fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await linkToTicket(req.id, "ticket_1");

    const updated = await setStatus(mgr.id, req.id, "IN_PROGRESS");

    expect(updated.status).toBe("IN_PROGRESS");
    const after = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe("IN_PROGRESS");
  });

  // Intercom is Direction 3's control surface: applyIntercomTicketStateChange
  // (intercom-sync.ts) lets an agent move a linked ticket OUT of a terminal
  // state from Intercom's own UI, deliberately bypassing the Hub's terminal
  // guard. setStatus must honor that same asymmetry, or a ticket an agent
  // mis-clicked into Resolved in Intercom would be locked out of every Hub
  // manager action even after Intercom itself moved it back.
  describe("setStatus and a terminal ticket linked to Intercom", () => {
    it("allows setStatus to move a linked ticket out of a terminal state", async () => {
      mockFetchOk();
      const owner = await createPerson("Owner");
      const mgr = await createPerson("Manager");
      await grantPermission(mgr.id, "support.manage_requests");
      const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
      await linkToTicket(req.id, "ticket_1");
      await cancelRequest(mgr.id, req.id, "No longer needed.");

      const updated = await setStatus(mgr.id, req.id, "IN_PROGRESS");
      expect(updated.status).toBe("IN_PROGRESS");
    });

    it("still blocks setStatus out of a terminal state for an UNLINKED ticket", async () => {
      const owner = await createPerson("Owner");
      const mgr = await createPerson("Manager");
      await grantPermission(mgr.id, "support.manage_requests");
      const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
      await cancelRequest(mgr.id, req.id, "No longer needed.");

      await expect(setStatus(mgr.id, req.id, "IN_PROGRESS")).rejects.toThrow(SupportStateError);
    });
  });
});
