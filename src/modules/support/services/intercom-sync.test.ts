/**
 * TDD tests for the Intercom <-> TechRequest.status sync (Direction 3, see
 * docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md):
 *
 * mapIntercomTicketStateToStatus / mapIntercomTicketTypeToCategory:
 *   - Explicit mapping tables, case-insensitive on the label text.
 *   - A status mapping miss returns null (reject, never guess); a category
 *     mapping miss falls back to OTHER (see intercom-sync.ts's doc comment
 *     for why the two differ).
 *
 * mapStatusToIntercomTicketState: the outbound direction, used by
 * notifications.ts's pushIntercomTicketState (tested in notifications.test.ts).
 *
 * The two directions are NOT mirrors and the tests below are written around
 * that. The Hub's status vocabulary and the workspace's state vocabulary differ
 * on purpose (ops writes the member-facing copy), and RESOLVED/CLOSED both map
 * outbound to "Resolved" because ops treats them as one outcome. So the useful
 * invariant is not "every status round-trips to itself" -- CLOSED cannot -- but
 * "every label the Hub can push is a label the Hub can read back", which is what
 * keeps a typo in either table from becoming silent one-way drift.
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
 *     calls anything that talks back to Intercom (no fetch call at all) --
 *     this covers BOTH outbound writes (the note in notifications.ts's
 *     notifyIntercomStatusChange and the Ticket-state push in
 *     pushIntercomTicketState), since applyIntercomTicketStateChange in this
 *     module never imports notifications.ts at all.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { TechRequestStatus } from "@prisma/client";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createTechRequestFromConversation } from "./tech-request";
import {
  mapIntercomTicketStateToStatus,
  mapIntercomTicketTypeToCategory,
  mapStatusToIntercomTicketState,
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
  // The exact internal labels the live workspace carries (GET /ticket_states,
  // 2026-08-12). These are ops' strings, not the Hub's -- "Waiting on YNHH ITS"
  // rather than the Hub's own "Awaiting YNHH" label -- which is the whole reason
  // the two tables are written out separately instead of derived from each other.
  it("maps each of the workspace's internal labels to its TechRequestStatus", () => {
    expect(mapIntercomTicketStateToStatus("Submitted")).toBe("SUBMITTED");
    expect(mapIntercomTicketStateToStatus("In progress")).toBe("IN_PROGRESS");
    expect(mapIntercomTicketStateToStatus("Awaiting user")).toBe("AWAITING_REQUESTER");
    expect(mapIntercomTicketStateToStatus("Waiting on YNHH ITS")).toBe("AWAITING_YNHH");
    expect(mapIntercomTicketStateToStatus("Resolved")).toBe("RESOLVED");
    expect(mapIntercomTicketStateToStatus("Cancelled")).toBe("CANCELLED");
  });

  // "Won't fix" is a real workspace state with no outbound counterpart. An agent
  // can pick it, so refusing it would mean the Hub silently ignoring a terminal
  // decision -- it lands on CLOSED, the Hub's quiet terminal status.
  it("maps Won't fix to CLOSED, even though nothing ever pushes that label", () => {
    expect(mapIntercomTicketStateToStatus("Won't fix")).toBe("CLOSED");
  });

  // That label is editable in Intercom's UI, and an editor that auto-substitutes
  // quotes turns U+0027 into U+2019 -- indistinguishable in a log line, and a
  // total lookup miss without this folding.
  it("folds a typographic apostrophe, so a smart-quoted Won't fix still maps", () => {
    expect(mapIntercomTicketStateToStatus("Won’t fix")).toBe("CLOSED");
  });

  it("is case-insensitive", () => {
    expect(mapIntercomTicketStateToStatus("in progress")).toBe("IN_PROGRESS");
    expect(mapIntercomTicketStateToStatus("RESOLVED")).toBe("RESOLVED");
    expect(mapIntercomTicketStateToStatus("waiting on ynhh its")).toBe("AWAITING_YNHH");
  });

  it("returns null for an unrecognized label rather than guessing", () => {
    expect(mapIntercomTicketStateToStatus("Some New State Nobody Mapped")).toBeNull();
  });

  // The Hub's OWN status labels are not Intercom's, and feeding one in must miss
  // rather than quietly work. If this ever starts passing, someone has renamed a
  // workspace state to match the Hub and the tables above need re-checking
  // against the live workspace, not just against each other.
  it("does not accept the Hub's own status label for a state ops named differently", () => {
    expect(mapIntercomTicketStateToStatus("Awaiting YNHH")).toBeNull();
    expect(mapIntercomTicketStateToStatus("Awaiting requester")).toBeNull();
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

const ALL_STATUSES: TechRequestStatus[] = [
  "SUBMITTED",
  "IN_PROGRESS",
  "AWAITING_REQUESTER",
  "AWAITING_YNHH",
  "RESOLVED",
  "CLOSED",
  "CANCELLED",
];

describe("mapStatusToIntercomTicketState", () => {
  it("maps a known TechRequestStatus to its Intercom state label, exact-case", () => {
    expect(mapStatusToIntercomTicketState("SUBMITTED")).toBe("Submitted");
    expect(mapStatusToIntercomTicketState("IN_PROGRESS")).toBe("In progress");
    expect(mapStatusToIntercomTicketState("AWAITING_REQUESTER")).toBe("Awaiting user");
    expect(mapStatusToIntercomTicketState("AWAITING_YNHH")).toBe("Waiting on YNHH ITS");
    expect(mapStatusToIntercomTicketState("RESOLVED")).toBe("Resolved");
    expect(mapStatusToIntercomTicketState("CANCELLED")).toBe("Cancelled");
  });

  // Ops treats closed and resolved as one outcome and did not want a second
  // terminal state in the member's view, so the mapping is deliberately
  // many-to-one. Asserted explicitly because it is the one place the two
  // directions cannot be mirrors, and a future reader "fixing" it by adding a
  // Closed state would be undoing a decision rather than repairing a bug.
  it("maps CLOSED onto the same Resolved state as RESOLVED", () => {
    expect(mapStatusToIntercomTicketState("CLOSED")).toBe("Resolved");
    expect(mapStatusToIntercomTicketState("RESOLVED")).toBe("Resolved");
  });

  // The real invariant, replacing a round-trip test that could not survive the
  // many-to-one mapping: anything the Hub can push must be something the Hub can
  // read back. A typo in either table breaks this, and would otherwise only show
  // up as one-way silent drift against the live workspace.
  it("only ever emits labels the inbound table recognizes", () => {
    for (const status of ALL_STATUSES) {
      const label = mapStatusToIntercomTicketState(status);
      expect(label).not.toBeNull();
      expect(mapIntercomTicketStateToStatus(label as string)).not.toBeNull();
    }
  });

  // Round-tripping holds for every status EXCEPT the collapsed pair, where
  // "Resolved" comes back as RESOLVED by deliberate choice (it is the status the
  // Hub's own resolve path sets).
  it("round-trips every status except CLOSED, which returns as RESOLVED", () => {
    for (const status of ALL_STATUSES.filter((s) => s !== "CLOSED")) {
      const label = mapStatusToIntercomTicketState(status);
      expect(mapIntercomTicketStateToStatus(label as string)).toBe(status);
    }
    expect(mapIntercomTicketStateToStatus(mapStatusToIntercomTicketState("CLOSED") as string)).toBe("RESOLVED");
  });

  // A status added to the TechRequestStatus enum without an accompanying
  // workspace state is exactly the drift this function must refuse to guess
  // at. There is no legitimate TechRequestStatus this happens for today (the
  // table is total), so the miss is simulated with a cast, the same
  // technique the enum-exhaustiveness guard itself exists to cover.
  it("returns null for a status with no mapped Intercom state, rather than guessing", () => {
    expect(mapStatusToIntercomTicketState("SOME_FUTURE_STATUS" as TechRequestStatus)).toBeNull();
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

  /**
   * Every sibling refusal in this module audits; this one only logged, and it
   * is the refusal that actually means the Hub and Intercom have diverged. The
   * signal is also cross-row: one occurrence can be a delivery-ordering race
   * against ticket.created, the same intercomTicketId twice is a permanently
   * orphaned Intercom ticket -- a distinction a log line that ages out of
   * retention cannot support (audit 14, finding 5).
   */
  it("audits an unknown ticket id, so an orphaned Intercom ticket leaves a durable trace", async () => {
    await applyIntercomTicketStateChange("215475503912170", "In progress");

    const rows = await prisma.auditLog.findMany({
      where: { action: "intercom_ticket_sync.ticket_not_found" },
    });
    expect(rows).toHaveLength(1);
    const after = rows[0].after as Record<string, unknown>;
    expect(after.intercomTicketId).toBe("215475503912170");
    expect(after.internalLabel).toBe("In progress");
    expect(rows[0].actorPersonId).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Staleness: Intercom guarantees no delivery ORDER and retries a failed
  // delivery for hours, so "arrived later" is not "happened later". Status
  // equality, the only guard there used to be, says nothing about age.
  // ---------------------------------------------------------------------
  describe("out-of-order deliveries", () => {
    const older = new Date("2026-08-16T03:05:00.000Z");
    const newer = new Date("2026-08-16T03:06:00.000Z");

    it("refuses an event older than the one already applied, leaving the newer status in place", async () => {
      const person = await createPerson("Alice");
      const ticket = await createLinkedTicket(person.id, "ticket_1");

      await applyIntercomTicketStateChange("ticket_1", "Resolved", newer);
      const result = await applyIntercomTicketStateChange("ticket_1", "In progress", older);

      // Reported as an accepted no-op rather than a failure: the delivery was
      // valid, it just lost its race, and a retry would refuse identically.
      expect(result.ok).toBe(true);
      expect(result.ok && result.changed).toBe(false);
      expect(result.ok && result.stale).toBe(true);
      const reloaded = await prisma.techRequest.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(reloaded.status).toBe("RESOLVED");
    });

    it("audits the refusal, so a silently dropped state change is still findable", async () => {
      const person = await createPerson("Alice");
      await createLinkedTicket(person.id, "ticket_1");

      await applyIntercomTicketStateChange("ticket_1", "Resolved", newer);
      await applyIntercomTicketStateChange("ticket_1", "In progress", older);

      const rows = await prisma.auditLog.findMany({ where: { action: "intercom_ticket_sync.stale_event" } });
      expect(rows).toHaveLength(1);
      expect((rows[0].after as Record<string, unknown>).status).toBe("IN_PROGRESS");
      expect((rows[0].before as Record<string, unknown>).status).toBe("RESOLVED");
    });

    it("applies an event newer than the one already applied", async () => {
      const person = await createPerson("Alice");
      const ticket = await createLinkedTicket(person.id, "ticket_1");

      await applyIntercomTicketStateChange("ticket_1", "In progress", older);
      const result = await applyIntercomTicketStateChange("ticket_1", "Resolved", newer);

      expect(result.ok).toBe(true);
      expect(result.ok && result.changed).toBe(true);
      const reloaded = await prisma.techRequest.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(reloaded.status).toBe("RESOLVED");
    });

    /**
     * The guard must fail OPEN. A payload with no usable timestamp, or a
     * ticket whose last change predates this field existing, has nothing to
     * compare against -- and "we cannot tell" must stay the old behavior of
     * applying the change, never become a new way to drop a real state change
     * on the floor.
     */
    it("applies a change when the incoming event carries no timestamp at all", async () => {
      const person = await createPerson("Alice");
      const ticket = await createLinkedTicket(person.id, "ticket_1");

      await applyIntercomTicketStateChange("ticket_1", "Resolved", newer);
      const result = await applyIntercomTicketStateChange("ticket_1", "In progress", null);

      expect(result.ok && result.changed).toBe(true);
      const reloaded = await prisma.techRequest.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(reloaded.status).toBe("IN_PROGRESS");
    });

    it("applies a change when the previously applied one recorded no timestamp", async () => {
      const person = await createPerson("Alice");
      const ticket = await createLinkedTicket(person.id, "ticket_1");

      await applyIntercomTicketStateChange("ticket_1", "Resolved", null);
      const result = await applyIntercomTicketStateChange("ticket_1", "In progress", older);

      expect(result.ok && result.changed).toBe(true);
      const reloaded = await prisma.techRequest.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(reloaded.status).toBe("IN_PROGRESS");
    });

    // The timestamp the guard reads back on the NEXT delivery. Without it in
    // the audit row there is nothing to compare against and the guard silently
    // stops rejecting anything, which is a regression no status assertion
    // above would catch on its own.
    it("records the applied event's timestamp on the audit row the guard reads", async () => {
      const person = await createPerson("Alice");
      await createLinkedTicket(person.id, "ticket_1");

      await applyIntercomTicketStateChange("ticket_1", "In progress", newer);

      const row = await prisma.auditLog.findFirstOrThrow({
        where: { action: "intercom_ticket_sync.status_change" },
      });
      expect((row.after as Record<string, unknown>).intercomEventAt).toBe(newer.toISOString());
    });
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
  // status change never talks back to Intercom at all -- BOTH outbound
  // writes: notifications.ts's notifyIntercomStatusChange (the conversation
  // note, Direction 2) and pushIntercomTicketState (the Ticket state push,
  // Direction 3's Hub-origin half) are only ever reachable via fetch, and
  // this module imports neither notifications.ts function. If a future edit
  // wired applyIntercomTicketStateChange to call either "for completeness,"
  // this test fails because that call goes through fetch.
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

      // "Waiting on YNHH ITS" is a real transition (SUBMITTED -> AWAITING_YNHH),
      // not a no-op, and it is a status with a mapped outbound Intercom
      // state too -- if pushIntercomTicketState were ever wired into this
      // path, this specific transition would have something to push.
      const result = await applyIntercomTicketStateChange("ticket_1", "Waiting on YNHH ITS");

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
