/**
 * TDD tests for the support module TechRequest service core.
 *
 * createTechRequest(actorPersonId, input):
 *   - Creates a SUBMITTED ticket owned by the requester, default priority MEDIUM.
 *   - Rejects a blank subject.
 *
 * Read access:
 *   - listMyRequests returns only the caller's tickets.
 *   - getTechRequest hides another person's ticket from a non-manager (SupportNotFoundError).
 *   - getTechRequest lets a manager read any ticket.
 *   - listAllRequests requires the manage permission.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createTechRequest,
  createTechRequestFromConversation,
  listMyRequests,
  getTechRequest,
  listAllRequests,
  isManager,
  SupportNotFoundError,
  SupportStateError,
} from "./tech-request";

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

beforeEach(resetDb);

describe("createTechRequest", () => {
  it("creates a SUBMITTED ticket owned by the requester", async () => {
    const p = await createPerson("Alice");
    const req = await createTechRequest(p.id, {
      category: "GENERAL_IT",
      subject: "Laptop won't connect",
      description: "Wifi drops on the clinic floor.",
    });
    expect(req.status).toBe("SUBMITTED");
    expect(req.requesterId).toBe(p.id);
    expect(req.priority).toBe("MEDIUM");
    expect(req.number).toBeGreaterThan(0);
  });

  it("rejects a blank subject", async () => {
    const p = await createPerson("Alice");
    await expect(
      createTechRequest(p.id, { category: "OTHER", subject: "  ", description: "x" })
    ).rejects.toThrow(/subject/i);
  });
});

describe("createTechRequestFromConversation", () => {
  it("creates a SUBMITTED ticket owned by the requester and stamps the conversation id", async () => {
    const p = await createPerson("Alice");
    const { ticket, created } = await createTechRequestFromConversation(p.id, {
      intercomConversationId: "conv_1",
      category: "GENERAL_IT",
      subject: "Laptop won't connect",
      description: "Wifi drops on the clinic floor.",
    });
    expect(created).toBe(true);
    expect(ticket.status).toBe("SUBMITTED");
    expect(ticket.requesterId).toBe(p.id);
    expect(ticket.intercomConversationId).toBe("conv_1");
  });

  it("is idempotent: a second call for the same conversation id returns the same ticket unchanged", async () => {
    const p = await createPerson("Alice");
    const first = await createTechRequestFromConversation(p.id, {
      intercomConversationId: "conv_1",
      category: "GENERAL_IT",
      subject: "Laptop won't connect",
      description: "Wifi drops on the clinic floor.",
    });
    // A retry can arrive with a different body (Fin re-composing its call) --
    // the existing ticket must come back unchanged regardless.
    const second = await createTechRequestFromConversation(p.id, {
      intercomConversationId: "conv_1",
      category: "OTHER",
      subject: "Different subject",
      description: "Different description",
    });

    expect(second.created).toBe(false);
    expect(second.ticket.id).toBe(first.ticket.id);
    expect(second.ticket.number).toBe(first.ticket.number);
    expect(second.ticket.category).toBe("GENERAL_IT");
    expect(await prisma.techRequest.count()).toBe(1);
  });

  it("survives two genuinely concurrent calls for the same conversation id without a raw constraint error", async () => {
    const p = await createPerson("Alice");
    const input = {
      intercomConversationId: "conv_race",
      category: "GENERAL_IT" as const,
      subject: "Laptop won't connect",
      description: "Wifi drops on the clinic floor.",
    };
    const [a, b] = await Promise.all([
      createTechRequestFromConversation(p.id, input),
      createTechRequestFromConversation(p.id, input),
    ]);

    expect(a.ticket.number).toBe(b.ticket.number);
    // Exactly one of the two calls did the actual insert.
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(await prisma.techRequest.count()).toBe(1);
  });

  it("rejects a blank subject", async () => {
    const p = await createPerson("Alice");
    await expect(
      createTechRequestFromConversation(p.id, {
        intercomConversationId: "conv_1",
        category: "OTHER",
        subject: "  ",
        description: "x",
      })
    ).rejects.toThrow(SupportStateError);
  });

  /**
   * The one thing an "idempotent, returns the existing row unchanged" path must
   * still write. A ticket opened by Fin's custom action has a conversation id
   * and no ticket id, because no Intercom Ticket exists yet; when Intercom
   * later converts that conversation into a Ticket, the ticket.created webhook
   * arrives with the SAME id. Returning early there left intercomTicketId null
   * forever, and nothing else in the codebase ever writes that column -- so
   * every inbound status path (which looks the row up BY that column) and the
   * reconciliation sweep (which filters on it) lost the ticket permanently and
   * silently (audit 14, SUP-1/INT-1).
   */
  describe("back-filling intercomTicketId", () => {
    async function seedConversationOnly(personId: string) {
      const { ticket } = await createTechRequestFromConversation(personId, {
        intercomConversationId: "conv_1",
        category: "GENERAL_IT",
        subject: "Laptop won't connect",
        description: "Wifi drops on the clinic floor.",
      });
      expect(ticket.intercomTicketId).toBeNull();
      return ticket;
    }

    it("links a conversation-only ticket when the ticket id finally arrives", async () => {
      const p = await createPerson("Alice");
      const seeded = await seedConversationOnly(p.id);

      const result = await createTechRequestFromConversation(p.id, {
        intercomConversationId: "conv_1",
        intercomTicketId: "conv_1",
        category: "GENERAL_IT",
        subject: "Laptop won't connect",
        description: "Wifi drops on the clinic floor.",
      });

      expect(result.created).toBe(false);
      expect(result.linked).toBe(true);
      expect(result.ticket.id).toBe(seeded.id);
      expect(result.ticket.intercomTicketId).toBe("conv_1");
      expect(await prisma.techRequest.count()).toBe(1);
    });

    it("audits the link, since nothing else records how a ticket acquired its Intercom ticket id", async () => {
      const p = await createPerson("Alice");
      const seeded = await seedConversationOnly(p.id);

      await createTechRequestFromConversation(p.id, {
        intercomConversationId: "conv_1",
        intercomTicketId: "conv_1",
        category: "GENERAL_IT",
        subject: "Laptop won't connect",
        description: "Wifi drops on the clinic floor.",
      });

      const rows = await prisma.auditLog.findMany({
        where: { action: "support.intercom_ticket_link", entityId: seeded.id },
      });
      expect(rows).toHaveLength(1);
      expect((rows[0].after as Record<string, unknown>).intercomTicketId).toBe("conv_1");
    });

    // Reporting `linked` on every retry would make the webhook re-push the Hub
    // ticket number to Intercom on each redelivery.
    it("reports linked only once, not on every subsequent retry", async () => {
      const p = await createPerson("Alice");
      await seedConversationOnly(p.id);
      const input = {
        intercomConversationId: "conv_1",
        intercomTicketId: "conv_1",
        category: "GENERAL_IT" as const,
        subject: "Laptop won't connect",
        description: "Wifi drops on the clinic floor.",
      };

      expect((await createTechRequestFromConversation(p.id, input)).linked).toBe(true);
      expect((await createTechRequestFromConversation(p.id, input)).linked).toBe(false);
    });

    // Never repoints an existing link. Two conversations Intercom merged into
    // one Ticket cannot both own it, and overwriting would hand the ticket id
    // to whichever delivery arrived last.
    it("leaves an existing intercomTicketId alone", async () => {
      const p = await createPerson("Alice");
      const first = await createTechRequestFromConversation(p.id, {
        intercomConversationId: "conv_1",
        intercomTicketId: "ticket_original",
        category: "GENERAL_IT",
        subject: "Laptop won't connect",
        description: "Wifi drops on the clinic floor.",
      });

      const second = await createTechRequestFromConversation(p.id, {
        intercomConversationId: "conv_1",
        intercomTicketId: "ticket_different",
        category: "GENERAL_IT",
        subject: "Laptop won't connect",
        description: "Wifi drops on the clinic floor.",
      });

      expect(second.linked).toBe(false);
      expect(second.ticket.id).toBe(first.ticket.id);
      expect(second.ticket.intercomTicketId).toBe("ticket_original");
    });

    // Concurrency, on the path that already had a race window: two deliveries
    // for the same conversation can both pass the lookup before either writes.
    // Exactly one may claim the (unique) ticket id, and neither may surface a
    // raw constraint violation.
    it("survives two concurrent back-fills for the same conversation", async () => {
      const p = await createPerson("Alice");
      const seeded = await seedConversationOnly(p.id);
      const input = {
        intercomConversationId: "conv_1",
        intercomTicketId: "conv_1",
        category: "GENERAL_IT" as const,
        subject: "Laptop won't connect",
        description: "Wifi drops on the clinic floor.",
      };

      const [a, b] = await Promise.all([
        createTechRequestFromConversation(p.id, input),
        createTechRequestFromConversation(p.id, input),
      ]);

      expect(a.ticket.id).toBe(seeded.id);
      expect(b.ticket.id).toBe(seeded.id);
      expect(
        (await prisma.techRequest.findUniqueOrThrow({ where: { id: seeded.id } })).intercomTicketId
      ).toBe("conv_1");
      expect(await prisma.techRequest.count()).toBe(1);
    });
  });
});

describe("read access", () => {
  it("listMyRequests returns only the caller's tickets", async () => {
    const a = await createPerson("Alice");
    const b = await createPerson("Bob");
    await createTechRequest(a.id, { category: "TEAMS", subject: "A", description: "x" });
    await createTechRequest(b.id, { category: "TEAMS", subject: "B", description: "y" });
    const rows = await listMyRequests(a.id);
    expect(rows.map((r) => r.subject)).toEqual(["A"]);
  });

  it("getTechRequest hides another person's ticket from a non-manager", async () => {
    const owner = await createPerson("Owner");
    const stranger = await createPerson("Stranger");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(getTechRequest(stranger.id, req.id)).rejects.toThrow(SupportNotFoundError);
  });

  it("getTechRequest lets a manager read any ticket", async () => {
    const owner = await createPerson("Owner");
    const mgr = await createPerson("Manager");
    await grantPermission(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const detail = await getTechRequest(mgr.id, req.id);
    expect(detail.id).toBe(req.id);
  });

  it("listAllRequests requires the manage permission", async () => {
    const p = await createPerson("Alice");
    await expect(listAllRequests(p.id, {})).rejects.toThrow(/permission/i);
  });

  it("listAllRequests admits a view-only holder", async () => {
    const owner = await createPerson("Owner");
    const auditor = await createPerson("Auditor");
    await grantPermission(auditor.id, "support.view_all_requests");
    await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const { rows } = await listAllRequests(auditor.id, {});
    expect(rows.map((r) => r.subject)).toEqual(["S"]);
  });

  it("getTechRequest lets a view-only holder read any ticket", async () => {
    const owner = await createPerson("Owner");
    const auditor = await createPerson("Auditor");
    await grantPermission(auditor.id, "support.view_all_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const detail = await getTechRequest(auditor.id, req.id);
    expect(detail.id).toBe(req.id);
  });

  it("view-only alone does not make someone a manager", async () => {
    // The distinction the whole permission rests on: read paths widen, every
    // write path (assignment, status, comments, Epic tools) keeps gating on
    // isManager, so granting view-only must never satisfy it.
    const auditor = await createPerson("Auditor");
    await grantPermission(auditor.id, "support.view_all_requests");
    expect(await isManager(auditor.id)).toBe(false);
  });
});
