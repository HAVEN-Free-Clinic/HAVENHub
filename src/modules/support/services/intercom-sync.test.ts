/**
 * TDD tests for the Intercom -> TechRequest.status sync (Direction 3, see
 * docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md):
 *
 * mapIntercomTicketStateToStatus / mapIntercomTicketTypeToCategory:
 *   - Explicit mapping tables, case-insensitive on the label text.
 *   - A status mapping miss returns null (reject, never guess); a category
 *     mapping miss falls back to OTHER (see intercom-sync.ts's doc comment
 *     for why the two differ).
 *
 * applyIntercomTicketStateChange(intercomTicketId, internalLabel):
 *   - Unmapped state: refused and audited, ticket status unchanged.
 *   - Unknown ticket id: refused, nothing written.
 *   - No-op guard: incoming status == current status writes and audits
 *     nothing, reports changed: false.
 *   - A real transition updates status and audits it.
 *   - Unlike manage.ts's setStatus, a TERMINAL current status does not block
 *     the transition -- Intercom is the control surface here.
 *   - The loop-suppression claim: applying an Intercom-origin change never
 *     calls anything that talks back to Intercom (no fetch call at all).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createTechRequestFromConversation } from "./tech-request";
import {
  mapIntercomTicketStateToStatus,
  mapIntercomTicketTypeToCategory,
  applyIntercomTicketStateChange,
} from "./intercom-sync";

async function createPerson(name: string) {
  return prisma.person.create({ data: { name, status: "ACTIVE" } });
}

async function createLinkedTicket(personId: string, ticketId: string) {
  const { ticket } = await createTechRequestFromConversation(personId, {
    intercomConversationId: `conv_${ticketId}`,
    intercomTicketId: ticketId,
    category: "GENERAL_IT",
    subject: "Wifi won't connect",
    description: "Dropping every few minutes on the clinic floor.",
  });
  return ticket;
}

beforeEach(resetDb);

describe("mapIntercomTicketStateToStatus", () => {
  it("maps a known internal label to its TechRequestStatus", () => {
    expect(mapIntercomTicketStateToStatus("In progress")).toBe("IN_PROGRESS");
    expect(mapIntercomTicketStateToStatus("Awaiting YNHH")).toBe("AWAITING_YNHH");
    expect(mapIntercomTicketStateToStatus("Resolved")).toBe("RESOLVED");
  });

  it("is case-insensitive", () => {
    expect(mapIntercomTicketStateToStatus("in progress")).toBe("IN_PROGRESS");
    expect(mapIntercomTicketStateToStatus("RESOLVED")).toBe("RESOLVED");
    expect(mapIntercomTicketStateToStatus("awaiting ynhh")).toBe("AWAITING_YNHH");
  });

  it("returns null for an unrecognized label rather than guessing", () => {
    expect(mapIntercomTicketStateToStatus("Some New State Nobody Mapped")).toBeNull();
  });
});

describe("mapIntercomTicketTypeToCategory", () => {
  it("maps a known ticket type name to its TechRequestCategory", () => {
    expect(mapIntercomTicketTypeToCategory("Epic access")).toBe("EPIC");
    expect(mapIntercomTicketTypeToCategory("HAVEN Hub")).toBe("HAVEN_HUB");
  });

  it("is case-insensitive", () => {
    expect(mapIntercomTicketTypeToCategory("general it")).toBe("GENERAL_IT");
  });

  it("falls back to OTHER for an unrecognized ticket type name, rather than refusing", () => {
    expect(mapIntercomTicketTypeToCategory("Some New Ticket Type")).toBe("OTHER");
  });

  it("falls back to OTHER when no ticket type name is available at all", () => {
    expect(mapIntercomTicketTypeToCategory(null)).toBe("OTHER");
  });
});

describe("applyIntercomTicketStateChange", () => {
  it("refuses and audits an unmapped state, leaving status unchanged", async () => {
    const person = await createPerson("Alice");
    const ticket = await createLinkedTicket(person.id, "ticket_1");

    const result = await applyIntercomTicketStateChange("ticket_1", "Some Brand New State");

    expect(result).toEqual({ ok: false, reason: "unmapped_state" });
    const reloaded = await prisma.techRequest.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(reloaded.status).toBe("SUBMITTED");
    const rows = await prisma.auditLog.findMany({ where: { action: "intercom_ticket_sync.unmapped_state" } });
    expect(rows).toHaveLength(1);
    expect((rows[0].after as Record<string, unknown>).internalLabel).toBe("Some Brand New State");
  });

  it("refuses an unknown ticket id without throwing", async () => {
    const result = await applyIntercomTicketStateChange("no-such-ticket", "In progress");
    expect(result).toEqual({ ok: false, reason: "ticket_not_found" });
  });

  it("is a no-op when the incoming status already equals the current one", async () => {
    const person = await createPerson("Alice");
    const ticket = await createLinkedTicket(person.id, "ticket_1");
    const before = await prisma.auditLog.count();

    const result = await applyIntercomTicketStateChange("ticket_1", "Submitted");

    expect(result.ok).toBe(true);
    expect(result.ok && result.changed).toBe(false);
    const reloaded = await prisma.techRequest.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(reloaded.status).toBe("SUBMITTED");
    expect(reloaded.updatedAt.getTime()).toBe(ticket.updatedAt.getTime());
    expect(await prisma.auditLog.count()).toBe(before);
  });

  it("applies a real transition and audits it", async () => {
    const person = await createPerson("Alice");
    await createLinkedTicket(person.id, "ticket_1");

    const result = await applyIntercomTicketStateChange("ticket_1", "In progress");

    expect(result.ok).toBe(true);
    expect(result.ok && result.changed).toBe(true);
    expect(result.ok && result.ticket.status).toBe("IN_PROGRESS");
    const rows = await prisma.auditLog.findMany({ where: { action: "intercom_ticket_sync.status_change" } });
    expect(rows).toHaveLength(1);
    expect((rows[0].before as Record<string, unknown>).status).toBe("SUBMITTED");
    expect((rows[0].after as Record<string, unknown>).status).toBe("IN_PROGRESS");
    expect((rows[0].after as Record<string, unknown>).source).toBe("intercom");
    expect(rows[0].actorPersonId).toBeNull();
  });

  it("allows moving a TERMINAL ticket to a new status -- Intercom is the control surface here, unlike manage.ts's setStatus", async () => {
    const person = await createPerson("Alice");
    const ticket = await createLinkedTicket(person.id, "ticket_1");
    await prisma.techRequest.update({ where: { id: ticket.id }, data: { status: "RESOLVED" } });

    const result = await applyIntercomTicketStateChange("ticket_1", "In progress");

    expect(result.ok).toBe(true);
    expect(result.ok && result.changed).toBe(true);
    expect(result.ok && result.ticket.status).toBe("IN_PROGRESS");
  });

  // ---------------------------------------------------------------------
  // Loop suppression: this is the test that would actually catch a loop,
  // not merely assert a guard exists. It proves applying an Intercom-origin
  // status change never talks back to Intercom at all -- if a future edit
  // wired this function to call notifyIntercomStatusChange "for
  // completeness," this test fails because that call goes through fetch.
  // ---------------------------------------------------------------------
  describe("loop suppression", () => {
    beforeEach(() => {
      vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
      vi.stubEnv("INTERCOM_BOT_ADMIN_ID", "admin-1");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it("never calls Intercom while applying an Intercom-originated status change", async () => {
      const person = await createPerson("Alice");
      await createLinkedTicket(person.id, "ticket_1");

      const result = await applyIntercomTicketStateChange("ticket_1", "Awaiting YNHH");

      expect(result.ok).toBe(true);
      expect(result.ok && result.changed).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("still does not call Intercom on a no-op redelivery", async () => {
      const person = await createPerson("Alice");
      await createLinkedTicket(person.id, "ticket_1");
      await applyIntercomTicketStateChange("ticket_1", "In progress");
      (fetch as unknown as ReturnType<typeof vi.fn>).mockClear();

      // Intercom redelivers the same event.
      const result = await applyIntercomTicketStateChange("ticket_1", "In progress");

      expect(result.ok).toBe(true);
      expect(result.ok && result.changed).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
