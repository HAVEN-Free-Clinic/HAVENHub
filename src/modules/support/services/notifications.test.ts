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
 *   the outbound Intercom sync's message-building and posting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createTechRequest } from "./tech-request";
import {
  notifyTicketSubmitted,
  buildIntercomStatusMessage,
  isPublicComment,
  notifyIntercomStatusChange,
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
    const message = buildIntercomStatusMessage(42, "AWAITING_YNHH", null);
    expect(message).not.toMatch(/\bwe will update you\b/i);
    expect(message).not.toMatch(/\byour (request|ticket)\b/i);
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
