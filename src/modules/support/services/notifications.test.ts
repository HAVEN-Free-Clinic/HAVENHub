/**
 * TDD tests for support module notification helpers.
 *
 * notifyTicketSubmitted(db, req, requester):
 *   - Confirms to the requester and alerts every support.manage_requests holder.
 *   - Does not double-notify when the requester also holds the manage permission.
 *   - Suppresses the requester confirmation (not the manager alert) for a
 *     ticket linked to an Intercom conversation.
 *
 * buildIntercomStatusMessage / isPublicComment / notifyIntercomStatusChange:
 *   Direction 2's outbound sync -- message-building and posting the
 *   staff-only conversation note.
 *
 * pushIntercomTicketState: Direction 3's Hub-origin outbound sync -- setting
 * the linked Intercom TICKET's own state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TechRequestStatus } from "@prisma/client";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createTechRequest } from "./tech-request";
import {
  notifyTicketSubmitted,
  buildIntercomStatusMessage,
  isPublicComment,
  notifyIntercomStatusChange,
  pushIntercomTicketState,
  buildEpicSubmissionNote,
  buildEpicResolutionNote,
  notifyEpicYnhhNote,
} from "./notifications";

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

beforeEach(resetDb);

describe("notifyTicketSubmitted", () => {
  it("confirms to the requester and alerts every manager", async () => {
    const requester = await createPerson("Rea Quester", { contactEmail: "req@example.com" });
    const mgr = await createPerson("Marla Manager", { contactEmail: "mgr@example.com" });
    await grantPermission(mgr.id, "support.manage_requests");

    const req = await createTechRequest(requester.id, {
      category: "GENERAL_IT",
      subject: "S",
      description: "d",
    });

    await notifyTicketSubmitted(prisma, req, requester);

    // The requester gets the receipt template; managers get the distinct alert template.
    const requesterLogs = await prisma.emailLog.findMany({ where: { template: "support.ticket_submitted" } });
    expect(requesterLogs.map((l) => l.toEmail)).toEqual(["req@example.com"]);
    const managerLogs = await prisma.emailLog.findMany({ where: { template: "support.ticket_manager_alert" } });
    expect(managerLogs.map((l) => l.toEmail)).toEqual(["mgr@example.com"]);
  });

  it("does not double-notify when the requester also holds the manage permission", async () => {
    const requester = await createPerson("Marla Manager", { contactEmail: "mgr@example.com" });
    await grantPermission(requester.id, "support.manage_requests");

    const req = await createTechRequest(requester.id, {
      category: "OTHER",
      subject: "S",
      description: "d",
    });

    await notifyTicketSubmitted(prisma, req, requester);

    // Only the requester receipt goes out; the manager alert is skipped for the
    // self-filer, so no manager-alert email is queued.
    const requesterLogs = await prisma.emailLog.findMany({ where: { template: "support.ticket_submitted" } });
    expect(requesterLogs).toHaveLength(1);
    expect(requesterLogs[0].toEmail).toBe("mgr@example.com");
    const managerLogs = await prisma.emailLog.findMany({ where: { template: "support.ticket_manager_alert" } });
    expect(managerLogs).toHaveLength(0);
  });

  it("suppresses the requester confirmation for a ticket linked to an Intercom conversation, but still alerts managers", async () => {
    const requester = await createPerson("Rea Quester", { contactEmail: "req@example.com" });
    const mgr = await createPerson("Marla Manager", { contactEmail: "mgr@example.com" });
    await grantPermission(mgr.id, "support.manage_requests");

    const req = await createTechRequest(requester.id, {
      category: "GENERAL_IT",
      subject: "S",
      description: "d",
    });
    const linked = await prisma.techRequest.update({
      where: { id: req.id },
      data: { intercomConversationId: "conv_1" },
    });

    await notifyTicketSubmitted(prisma, linked, requester);

    const requesterLogs = await prisma.emailLog.findMany({ where: { template: "support.ticket_submitted" } });
    expect(requesterLogs).toHaveLength(0);
    const managerLogs = await prisma.emailLog.findMany({ where: { template: "support.ticket_manager_alert" } });
    expect(managerLogs.map((l) => l.toEmail)).toEqual(["mgr@example.com"]);
  });
});

describe("buildIntercomStatusMessage", () => {
  /**
   * AWAITING_YNHH is the status Intercom has no native equivalent for, and the
   * one an agent most needs spelled out: it means blocked on an external body,
   * not waiting on the member and not sitting unworked by HAVEN IT. A generic
   * "on hold" would lose exactly that.
   */
  it("names YNHH explicitly for AWAITING_YNHH rather than something generic", () => {
    const message = buildIntercomStatusMessage(42, "AWAITING_YNHH", null);
    expect(message).toMatch(/Yale New Haven Health|YNHH/);
    expect(message).toMatch(/blocked|external/i);
  });

  /**
   * These are internal notes, not replies (see postConversationNote), so the
   * text must read to the agent working the ticket. Second-person phrasing
   * would look like something the member had already been told, when nothing
   * was sent to them at all.
   */
  it("addresses staff, not the member, since the note is never shown to them", () => {
    // Every status, not just AWAITING_YNHH. Checking only that branch is how
    // the generic fallback kept saying "Your IT Support ticket #N is now X"
    // after these stopped being customer-visible replies.
    const statuses: TechRequestStatus[] = [
      "SUBMITTED",
      "IN_PROGRESS",
      "AWAITING_REQUESTER",
      "AWAITING_YNHH",
      "RESOLVED",
      "CLOSED",
      "CANCELLED",
    ];
    for (const status of statuses) {
      const message = buildIntercomStatusMessage(42, status, null);
      expect(message, `${status} addresses the member`).not.toMatch(/\bwe will update you\b/i);
      expect(message, `${status} addresses the member`).not.toMatch(/\byour\b/i);
    }
  });

  it("uses the member-facing status label for other statuses", () => {
    const message = buildIntercomStatusMessage(42, "IN_PROGRESS", null);
    expect(message).toContain("#42");
    expect(message).toContain("In progress");
  });

  it("appends the resolution text when there is one", () => {
    const message = buildIntercomStatusMessage(42, "RESOLVED", "Reset the WiFi adapter driver.");
    expect(message).toContain("Resolved");
    expect(message).toContain("Reset the WiFi adapter driver.");
  });

  it("omits any resolution section when there is none", () => {
    const message = buildIntercomStatusMessage(42, "IN_PROGRESS", null);
    expect(message.includes("\n\n")).toBe(false);
  });
});

describe("isPublicComment", () => {
  it("allows PUBLIC and refuses INTERNAL -- the hard boundary any comment-forwarding code must pass through", () => {
    expect(isPublicComment({ visibility: "PUBLIC" })).toBe(true);
    expect(isPublicComment({ visibility: "INTERNAL" })).toBe(false);
  });
});

describe("notifyIntercomStatusChange", () => {
  beforeEach(() => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
    vi.stubEnv("INTERCOM_BOT_ADMIN_ID", "admin-1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts into the conversation for a linked ticket", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));

    await notifyIntercomStatusChange({
      id: "t1",
      number: 7,
      status: "IN_PROGRESS",
      intercomConversationId: "conv_1",
    });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("conv_1");
  });

  it("does not call Intercom at all for an unlinked ticket", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await notifyIntercomStatusChange({
      id: "t1",
      number: 7,
      status: "IN_PROGRESS",
      intercomConversationId: null,
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not throw when Intercom is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(
      notifyIntercomStatusChange({
        id: "t1",
        number: 7,
        status: "IN_PROGRESS",
        intercomConversationId: "conv_1",
      })
    ).resolves.toBeUndefined();
  });
});

describe("pushIntercomTicketState", () => {
  beforeEach(() => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("pushes the mapped state for a ticket with an intercomTicketId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));

    await pushIntercomTicketState(
      { id: "t1", number: 7, status: "IN_PROGRESS", intercomTicketId: "ticket_1" },
      "SUBMITTED"
    );

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("ticket_1");
    const body = JSON.parse(init.body as string) as { state: string };
    expect(body.state).toBe("In progress");
  });

  it("does not call Intercom at all for a ticket with no intercomTicketId", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await pushIntercomTicketState(
      { id: "t1", number: 7, status: "IN_PROGRESS", intercomTicketId: null },
      "SUBMITTED"
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  // Necessary but not sufficient for loop suppression on its own (see this
  // function's doc comment) -- the structural module split is the primary
  // defence -- but still required: a ticket already at its target status
  // must not trigger a write.
  it("does not call Intercom when the ticket is already in the target state", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await pushIntercomTicketState(
      { id: "t1", number: 7, status: "IN_PROGRESS", intercomTicketId: "ticket_1" },
      "IN_PROGRESS"
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  // Simulated via a cast, same technique as intercom-sync.test.ts's matching
  // test -- there is no legitimate TechRequestStatus this happens for today
  // (mapStatusToIntercomTicketState is total over the real enum), but a
  // future status added without an accompanying workspace state must be
  // refused, not guessed at.
  it("logs and writes nothing for a status with no mapped Intercom state", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await pushIntercomTicketState(
      { id: "t1", number: 7, status: "SOME_FUTURE_STATUS" as TechRequestStatus, intercomTicketId: "ticket_1" },
      "SUBMITTED"
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not throw when Intercom is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(
      pushIntercomTicketState(
        { id: "t1", number: 7, status: "IN_PROGRESS", intercomTicketId: "ticket_1" },
        "SUBMITTED"
      )
    ).resolves.toBeUndefined();
  });
});

describe("buildEpicSubmissionNote", () => {
  it("names the kind, person, and YNHH SR# when one is on file", () => {
    const note = buildEpicSubmissionNote(
      [{ kind: "NEW", personName: "Alice Volunteer" }],
      { id: "ticket-1", serviceRequestNumber: "SR-9999" }
    );
    expect(note).toContain("New account for Alice Volunteer");
    expect(note).toContain("YNHH SR# SR-9999");
  });

  it("falls back to the internal ticket id when no SR# has been set yet", () => {
    const note = buildEpicSubmissionNote(
      [{ kind: "MODIFY", personName: "Bob Volunteer" }],
      { id: "ticket-2", serviceRequestNumber: null }
    );
    expect(note).toContain("ticket-2");
    expect(note).toMatch(/no SR# on file yet/i);
  });

  it("names every request when several were submitted onto the same ticket", () => {
    const note = buildEpicSubmissionNote(
      [
        { kind: "NEW", personName: "Alice Volunteer" },
        { kind: "RENEW", personName: "Cara Director" },
      ],
      { id: "ticket-3", serviceRequestNumber: null }
    );
    expect(note).toContain("New account for Alice Volunteer");
    expect(note).toContain("Renewal for Cara Director");
  });
});

describe("buildEpicResolutionNote", () => {
  it("names the completed request and the YNHH ticket it moved back off of", () => {
    const note = buildEpicResolutionNote(
      { kind: "NEW", personName: "Alice Volunteer", outcome: "COMPLETED" },
      { id: "ticket-1", serviceRequestNumber: "SR-9999" }
    );
    expect(note).toContain("New account for Alice Volunteer");
    expect(note).toContain("completed");
    expect(note).toContain("SR-9999");
    expect(note).toMatch(/In Progress/);
  });

  it("names a cancelled request distinctly from a completed one", () => {
    const note = buildEpicResolutionNote(
      { kind: "MODIFY", personName: "Bob Volunteer", outcome: "CANCELLED" },
      { id: "ticket-2", serviceRequestNumber: null }
    );
    expect(note).toContain("cancelled");
    expect(note).not.toContain("completed");
  });

  it("still names the request when it was never linked to a YNHH ticket", () => {
    const note = buildEpicResolutionNote(
      { kind: "RENEW", personName: "Cara Director", outcome: "CANCELLED" },
      null
    );
    expect(note).toContain("Renewal for Cara Director");
    expect(note).toContain("cancelled");
  });
});

describe("notifyEpicYnhhNote", () => {
  beforeEach(() => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
    vi.stubEnv("INTERCOM_BOT_ADMIN_ID", "admin-1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts the given message into the conversation for a linked ticket", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));

    await notifyEpicYnhhNote(
      { id: "t1", number: 7, intercomConversationId: "conv_1" },
      "Submitted to YNHH: New account for Alice. YNHH ticket ticket-1 (no SR# on file yet)."
    );

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("conv_1");
    const body = JSON.parse(init.body as string) as { body: string };
    expect(body.body).toContain("New account for Alice");
  });

  it("does not call Intercom at all for an unlinked ticket", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await notifyEpicYnhhNote({ id: "t1", number: 7, intercomConversationId: null }, "message");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not throw when Intercom is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(
      notifyEpicYnhhNote({ id: "t1", number: 7, intercomConversationId: "conv_1" }, "message")
    ).resolves.toBeUndefined();
  });
});
