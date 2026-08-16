/**
 * TDD tests for the reconciliation sweep (see
 * docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md, Direction
 * 3, and this module's own doc comment for why it is report-only):
 *
 *   - No access token configured: an all-zero summary, no query at all.
 *   - Only rows with a linked intercomTicketId are checked.
 *   - In sync: counted, nothing audited.
 *   - Mismatch: counted, audited with before/after, TechRequest.status is
 *     NEVER written (the report-over-repair guarantee this module exists to
 *     make good on).
 *   - Unmapped Intercom state: counted and audited separately from a
 *     mismatch, status untouched.
 *   - Intercom unreachable for one ticket: counted as unreachable, not as a
 *     mismatch, and nothing audited for it -- "we don't know" must never
 *     become "they disagree".
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createTechRequestFromConversation } from "./tech-request";
import { reconcileIntercomTickets } from "./intercom-reconcile";

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

/** Maps a ticket id to a canned fetch response for GET /tickets/{id}, keyed off the URL. */
function mockFetchByTicket(responses: Record<string, { ok: boolean; status?: number; label?: string | null }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const match = Object.keys(responses).find((id) => url.includes(`/tickets/${id}`));
      const resp = match ? responses[match] : { ok: false, status: 404 };
      if (!resp.ok) {
        return { ok: false, status: resp.status ?? 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ ticket_state_internal_label: resp.label }) };
    })
  );
}

/** Answers every GET /tickets/{id} with the same label, recording which ids were asked for. */
function mockFetchRecording(label: string): string[] {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(String(url).split("/tickets/")[1] ?? "");
      return { ok: true, status: 200, json: async () => ({ ticket_state_internal_label: label }) };
    })
  );
  return asked;
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("reconcileIntercomTickets", () => {
  it("returns an all-zero summary and makes no request when Intercom has no access token configured", async () => {
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", vi.fn());
    const person = await createPerson("Sam Rivera");
    await createLinkedTicket(person.id, "ticket_1");

    const summary = await reconcileIntercomTickets();

    expect(summary).toEqual({ checked: 0, inSync: 0, mismatched: 0, unmappedIntercomState: 0, unreachable: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores a ticket with no linked Intercom ticket", async () => {
    mockFetchByTicket({});
    const person = await createPerson("Sam Rivera");
    // A Hub-form submission has no intercomTicketId at all.
    await prisma.techRequest.create({
      data: { requesterId: person.id, category: "OTHER", subject: "S", description: "d", status: "SUBMITTED" },
    });

    const summary = await reconcileIntercomTickets();

    expect(summary.checked).toBe(0);
  });

  it("counts an in-sync ticket and audits nothing", async () => {
    const person = await createPerson("Sam Rivera");
    const ticket = await createLinkedTicket(person.id, "ticket_2");
    mockFetchByTicket({ ticket_2: { ok: true, label: "Submitted" } });

    const summary = await reconcileIntercomTickets();

    expect(summary).toEqual({ checked: 1, inSync: 1, mismatched: 0, unmappedIntercomState: 0, unreachable: 0 });
    // Scoped to this module's own actions: createLinkedTicket itself audits
    // "support.request_create" on the same entityId, which is expected and
    // not what this assertion is about.
    const audits = await prisma.auditLog.findMany({
      where: { entityId: ticket.id, action: { startsWith: "intercom_reconcile." } },
    });
    expect(audits).toHaveLength(0);
    expect((await prisma.techRequest.findUnique({ where: { id: ticket.id } }))?.status).toBe("SUBMITTED");
  });

  it("reports and audits a status mismatch WITHOUT ever writing TechRequest.status", async () => {
    const person = await createPerson("Sam Rivera");
    const ticket = await createLinkedTicket(person.id, "ticket_3");
    mockFetchByTicket({ ticket_3: { ok: true, label: "In progress" } });

    const summary = await reconcileIntercomTickets();

    expect(summary).toEqual({ checked: 1, inSync: 0, mismatched: 1, unmappedIntercomState: 0, unreachable: 0 });
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: ticket.id, action: { startsWith: "intercom_reconcile." } },
    });
    expect(audit?.action).toBe("intercom_reconcile.status_mismatch");
    expect((audit?.before as { hubStatus?: string } | null)?.hubStatus).toBe("SUBMITTED");
    expect((audit?.after as { intercomMappedStatus?: string } | null)?.intercomMappedStatus).toBe("IN_PROGRESS");
    // The report-over-repair guarantee: the mismatch is audited, but the row
    // itself is untouched.
    expect((await prisma.techRequest.findUnique({ where: { id: ticket.id } }))?.status).toBe("SUBMITTED");
  });

  it("reports and audits an unmapped Intercom state, distinct from a mismatch, and leaves status untouched", async () => {
    const person = await createPerson("Sam Rivera");
    const ticket = await createLinkedTicket(person.id, "ticket_4");
    mockFetchByTicket({ ticket_4: { ok: true, label: "Some Brand New State" } });

    const summary = await reconcileIntercomTickets();

    expect(summary).toEqual({ checked: 1, inSync: 0, mismatched: 0, unmappedIntercomState: 1, unreachable: 0 });
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: ticket.id, action: { startsWith: "intercom_reconcile." } },
    });
    expect(audit?.action).toBe("intercom_reconcile.unmapped_state");
    expect((await prisma.techRequest.findUnique({ where: { id: ticket.id } }))?.status).toBe("SUBMITTED");
  });

  it("counts an unreachable ticket as unreachable, not as a mismatch, and audits nothing for it", async () => {
    const person = await createPerson("Sam Rivera");
    const ticket = await createLinkedTicket(person.id, "ticket_5");
    mockFetchByTicket({ ticket_5: { ok: false, status: 500 } });

    const summary = await reconcileIntercomTickets();

    expect(summary).toEqual({ checked: 1, inSync: 0, mismatched: 0, unmappedIntercomState: 0, unreachable: 1 });
    const audits = await prisma.auditLog.findMany({
      where: { entityId: ticket.id, action: { startsWith: "intercom_reconcile." } },
    });
    expect(audits).toHaveLength(0);
  });

  it("checks every linked ticket in one run and tallies them independently", async () => {
    const person = await createPerson("Sam Rivera");
    const inSync = await createLinkedTicket(person.id, "ticket_6");
    const mismatched = await createLinkedTicket(person.id, "ticket_7");
    mockFetchByTicket({
      ticket_6: { ok: true, label: "Submitted" },
      ticket_7: { ok: true, label: "Resolved" },
    });

    const summary = await reconcileIntercomTickets();

    expect(summary).toEqual({ checked: 2, inSync: 1, mismatched: 1, unmappedIntercomState: 0, unreachable: 0 });
    expect((await prisma.techRequest.findUnique({ where: { id: inSync.id } }))?.status).toBe("SUBMITTED");
    expect((await prisma.techRequest.findUnique({ where: { id: mismatched.id } }))?.status).toBe("SUBMITTED");
  });

  /**
   * The sweep is capped per run so a large backlog cannot time out mid-scan.
   * Without a cursor persisted between runs, every run restarted from
   * `orderBy: id asc` -- so the (cap + 1)th linked ticket onwards was never
   * read by any run, ever, while the summary reported a clean sweep. A backstop
   * for silently missed status syncs that silently misses statuses is worse
   * than none, because it is trusted (audit 14, SUP-4).
   *
   * maxRows stands in for the 500-row production ceiling so this can be
   * exercised with three rows instead of five hundred; the cursor logic under
   * test is identical either way.
   */
  describe("cursor", () => {
    async function seedThree() {
      const person = await createPerson("Sam Rivera");
      // ids are cuids, so seeding order does not fix scan order; the sweep
      // walks id-ascending and the assertions below follow that same order.
      const tickets = [
        await createLinkedTicket(person.id, "ticket_a"),
        await createLinkedTicket(person.id, "ticket_b"),
        await createLinkedTicket(person.id, "ticket_c"),
      ];
      return tickets.sort((x, y) => (x.id < y.id ? -1 : 1));
    }

    it("resumes past where the previous capped run stopped, instead of re-scanning the same head", async () => {
      const ordered = await seedThree();
      const asked = mockFetchRecording("Submitted");

      await reconcileIntercomTickets({ maxRows: 2 });
      expect(asked).toEqual([ordered[0].intercomTicketId, ordered[1].intercomTicketId]);

      asked.length = 0;
      const second = await reconcileIntercomTickets({ maxRows: 2 });

      // The third ticket is the one the uncursored sweep could never reach.
      expect(asked).toEqual([ordered[2].intercomTicketId]);
      expect(second.checked).toBe(1);
    });

    it("persists the cursor between runs in the Setting table", async () => {
      const ordered = await seedThree();
      mockFetchRecording("Submitted");

      await reconcileIntercomTickets({ maxRows: 2 });

      const row = await prisma.setting.findUnique({ where: { key: "intercom.reconcileCursor" } });
      expect((row?.value as { lastId?: string } | null)?.lastId).toBe(ordered[1].id);
    });

    /**
     * A sweep that only ever moved forward would check each ticket once and
     * then go quiet, which is the opposite of a drift detector's job: drift
     * appears at any time on a ticket that was in sync yesterday.
     */
    it("wraps back to the start once it reaches the end of the table", async () => {
      const ordered = await seedThree();
      const asked = mockFetchRecording("Submitted");

      await reconcileIntercomTickets({ maxRows: 2 });
      await reconcileIntercomTickets({ maxRows: 2 });

      const row = await prisma.setting.findUnique({ where: { key: "intercom.reconcileCursor" } });
      expect((row?.value as { lastId?: string | null } | null)?.lastId).toBeNull();

      asked.length = 0;
      await reconcileIntercomTickets({ maxRows: 2 });
      expect(asked).toEqual([ordered[0].intercomTicketId, ordered[1].intercomTicketId]);
    });

    // A run that fits inside its budget has nothing to resume from, so it must
    // not leave a cursor behind that would make the NEXT run skip the head of
    // the table.
    it("leaves no cursor when a single run covers everything", async () => {
      await seedThree();
      mockFetchRecording("Submitted");

      await reconcileIntercomTickets();

      const row = await prisma.setting.findUnique({ where: { key: "intercom.reconcileCursor" } });
      expect((row?.value as { lastId?: string | null } | null)?.lastId).toBeNull();
    });

    // A cursor outlives the row it names: the ticket it points at can be
    // deleted between runs. The sweep resumes after that id rather than
    // failing or restarting.
    it("survives a cursor pointing at a ticket that has since been deleted", async () => {
      const ordered = await seedThree();
      const asked = mockFetchRecording("Submitted");

      await reconcileIntercomTickets({ maxRows: 2 });
      await prisma.techRequest.delete({ where: { id: ordered[1].id } });

      asked.length = 0;
      const summary = await reconcileIntercomTickets({ maxRows: 2 });

      expect(asked).toEqual([ordered[2].intercomTicketId]);
      expect(summary.checked).toBe(1);
    });
  });
});
