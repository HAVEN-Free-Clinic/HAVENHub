import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

// Real identity.ts EXCEPT resolveIdentityFromConversation, which every
// ticket.created test drives directly rather than exercising the real
// Intercom HTTP lookup -- that lookup already has its own coverage in
// identity.test.ts. Same technique as from-conversation/route.test.ts.
vi.mock("@/platform/intercom/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/intercom/identity")>();
  return { ...actual, resolveIdentityFromConversation: vi.fn() };
});

// Stubbed so the notification fan-out can be asserted without rendering
// templates or touching the email queue.
vi.mock("@/modules/support/services/notifications", () => ({
  notifyTicketSubmitted: vi.fn(),
}));

import { resolveIdentityFromConversation, UNIDENTIFIED_MESSAGE } from "@/platform/intercom/identity";
import { notifyTicketSubmitted } from "@/modules/support/services/notifications";
import { createTechRequestFromConversation } from "@/modules/support/services/tech-request";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

/** The exact refusal line the ticket.state.updated diagnostic emits. */
const MISSING_FIELDS_MESSAGE = "[support] ticket.state.updated webhook missing a ticket id or state label";

/**
 * The structured attributes a `log.warn` call carried, read back off the
 * console mirror.
 *
 * @/platform/logging emits `console.warn(message, attrs)` and OMITS the second
 * argument entirely when the attribute map is empty -- which is what a log line
 * with nothing in it looks like from here, and exactly the shape the four
 * production refusals on 2026-08-13 had.
 */
function warnAttrs(
  spy: { mock: { calls: unknown[][] } },
  message: string
): Record<string, unknown> | undefined {
  const call = spy.mock.calls.find((args) => args[0] === message);
  return call?.[1] as Record<string, unknown> | undefined;
}

const WEBHOOK_SECRET = "client-secret-high-entropy";
const URL = "https://hub.test/api/support/tickets/events";

function sign(body: string, secret: string): string {
  return `sha1=${createHmac("sha1", secret).update(body, "utf8").digest("hex")}`;
}

function rawReq(raw: string, headers: Record<string, string>): Request {
  return new Request(URL, { method: "POST", headers, body: raw });
}

function signedReq(bodyObj: unknown, secret: string = WEBHOOK_SECRET): Request {
  const raw = JSON.stringify(bodyObj);
  return rawReq(raw, { "Content-Type": "application/json", "X-Hub-Signature": sign(raw, secret) });
}

/**
 * All values required to turn the webhook receiver on. Includes the Messenger
 * pair (app id + secret) because isWebhookConfigured chains through
 * isIntercomConfigured -- see config.ts's doc comment: without the Messenger,
 * no contact ever gets an external_id, so resolveIdentityFromConversation
 * could never succeed anyway.
 */
function configure() {
  vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
  vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
  vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
  vi.stubEnv("INTERCOM_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("INTERCOM_BOT_ADMIN_ID", "admin-1");
}

function ticketCreatedPayload(overrides: Record<string, unknown> = {}) {
  return {
    topic: "ticket.created",
    data: {
      item: {
        type: "ticket",
        id: "ticket_1",
        ticket_id: "1390",
        ticket_attributes: {
          _default_title_: "Wifi won't connect",
          _default_description_: "Dropping every few minutes on the clinic floor.",
        },
        ticket_type: { name: "General IT" },
        ticket_state_internal_label: "Submitted",
        // Deliberately names a DIFFERENT person than the mocked identity
        // resolution below, so the "ignores the payload" test can assert
        // this is never what decides the requester.
        contacts: { contacts: [{ external_id: "someone-else-entirely" }] },
        ...overrides,
      },
    },
  };
}

/**
 * The state block Intercom actually sends on API 2.12 and later, captured from
 * the live workspace on 2026-08-13 (GET /tickets/215475467632476 at 2.14).
 *
 * These tests used to build the PRE-2.12 shape -- a flat
 * `ticket_state_internal_label` on the item -- which is the same shape the
 * handler read, so the suite passed green while every real delivery 400'd. The
 * fixture, not the assertion, was the thing that could not fail. Anything
 * asserting the sync works must be built from a payload Intercom would really
 * send; the legacy shape keeps its own explicit test below rather than being
 * the default here.
 */
function ticketStateUpdatedPayload(ticketId: string, internalLabel: string) {
  return {
    topic: "ticket.state.updated",
    data: {
      item: {
        type: "ticket",
        id: ticketId,
        ticket_state: {
          type: "ticket_state",
          id: "4706544",
          category: "in_progress",
          internal_label: internalLabel,
          external_label: internalLabel,
        },
      },
    },
  };
}

/** The pre-2.12 serialization, still accepted. See ticketStateUpdatedPayload. */
function legacyTicketStateUpdatedPayload(ticketId: string, internalLabel: string) {
  return {
    topic: "ticket.state.updated",
    data: {
      item: { type: "ticket", id: ticketId, ticket_state_internal_label: internalLabel },
    },
  };
}

async function createPerson(name: string) {
  return prisma.person.create({ data: { name, status: "ACTIVE" } });
}

function mockFetchOk() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
}

describe("POST /api/support/tickets/events", () => {
  beforeEach(async () => {
    await resetDb();
    vi.resetAllMocks();
    configure();
    mockFetchOk();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    // The diagnostic tests below install a console spy; restoring it here keeps
    // a silenced console.warn from leaking into a later test's output.
    vi.restoreAllMocks();
  });

  describe("signature verification", () => {
    it("404s when the webhook receiver is not configured", async () => {
      vi.stubEnv("INTERCOM_WEBHOOK_SECRET", "");
      const { POST } = await import("./route");
      const res = await POST(signedReq(ticketCreatedPayload()));
      expect(res.status).toBe(404);
      expect(await prisma.techRequest.count()).toBe(0);
    });

    /**
     * isWebhookConfigured chains through isIntercomConfigured (config.ts): a
     * webhook secret and access token with no Messenger would 401 every
     * single ticket.created forever, since resolveIdentityFromConversation
     * can never find a contact with no external_id for the Messenger to have
     * set. Staying off is the same "unset = feature off" posture as every
     * other Intercom-facing route, rather than failing obscurely live.
     */
    it("404s when the webhook secret and access token are set but the Messenger is not", async () => {
      vi.stubEnv("INTERCOM_MESSENGER_SECRET", "");
      const { POST } = await import("./route");
      const res = await POST(signedReq(ticketCreatedPayload()));
      expect(res.status).toBe(404);
      expect(await prisma.techRequest.count()).toBe(0);
    });

    it("401s and creates nothing when the signature header is missing", async () => {
      const { POST } = await import("./route");
      const raw = JSON.stringify(ticketCreatedPayload());
      const res = await POST(rawReq(raw, { "Content-Type": "application/json" }));

      expect(res.status).toBe(401);
      expect(await prisma.techRequest.count()).toBe(0);
      expect(resolveIdentityFromConversation).not.toHaveBeenCalled();
    });

    it("401s and creates nothing when the signature is computed with the wrong secret", async () => {
      const { POST } = await import("./route");
      const res = await POST(signedReq(ticketCreatedPayload(), "wrong-secret"));

      expect(res.status).toBe(401);
      expect(await prisma.techRequest.count()).toBe(0);
      expect(resolveIdentityFromConversation).not.toHaveBeenCalled();
    });

    it("400s and changes nothing when a validly-signed body is not parseable JSON", async () => {
      const { POST } = await import("./route");
      const raw = "not valid json at all {{{";
      const res = await POST(rawReq(raw, { "Content-Type": "application/json", "X-Hub-Signature": sign(raw, WEBHOOK_SECRET) }));

      expect(res.status).toBe(400);
      expect(await prisma.techRequest.count()).toBe(0);
    });

    it("400s and changes nothing when a validly-signed body does not match the expected envelope", async () => {
      const { POST } = await import("./route");
      const res = await POST(signedReq({ nothing: "to see here" }));

      expect(res.status).toBe(400);
      expect(await prisma.techRequest.count()).toBe(0);
    });

    it("200s and ignores a topic it does not handle, without touching the database", async () => {
      const { POST } = await import("./route");
      const res = await POST(signedReq({ topic: "conversation.admin.replied", data: { item: {} } }));

      expect(res.status).toBe(200);
      expect(await prisma.techRequest.count()).toBe(0);
    });

    /**
     * WebhookEnvelopeSchema used to require data.item unconditionally, so this
     * exact shape -- an unhandled topic with no item at all, which is what
     * Intercom's own subscription-verification ping looks like -- 400'd
     * instead of being ignored, and showed as a permanent delivery failure in
     * Intercom's dashboard for traffic this endpoint was never meant to
     * process.
     */
    it("200s and ignores an unhandled topic whose payload has no data.item at all", async () => {
      const { POST } = await import("./route");
      const res = await POST(signedReq({ topic: "ping", data: {} }));

      expect(res.status).toBe(200);
      expect(await prisma.techRequest.count()).toBe(0);
    });
  });

  describe("ticket.created", () => {
    it("creates a SUBMITTED ticket owned by the person resolved from the conversation, linking both Intercom ids", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });

      const { POST } = await import("./route");
      const res = await POST(signedReq(ticketCreatedPayload()));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.created).toBe(true);
      const ticket = await prisma.techRequest.findUnique({ where: { number: json.number } });
      expect(ticket?.requesterId).toBe(person.id);
      expect(ticket?.status).toBe("SUBMITTED");
      expect(ticket?.intercomConversationId).toBe("ticket_1");
      expect(ticket?.intercomTicketId).toBe("ticket_1");
      expect(ticket?.category).toBe("GENERAL_IT");
      expect(ticket?.subject).toBe("Wifi won't connect");
    });

    it("ignores contact data in the payload and uses only the identity resolved from the conversation", async () => {
      const requester = await createPerson("Sam Rivera");
      const impersonated = await createPerson("Someone Else");
      mocked(resolveIdentityFromConversation).mockResolvedValue({
        ok: true,
        personId: requester.id,
        name: requester.name,
      });

      const { POST } = await import("./route");
      // The payload's own "contacts" field names `impersonated` by a
      // completely different mechanism (external_id), not by our Person id --
      // there is no way for a webhook handler that trusted the payload
      // directly to land on `requester` here.
      const res = await POST(signedReq(ticketCreatedPayload()));
      const json = await res.json();

      const ticket = await prisma.techRequest.findUnique({ where: { number: json.number } });
      expect(ticket?.requesterId).toBe(requester.id);
      expect(ticket?.requesterId).not.toBe(impersonated.id);
    });

    it("refuses with the shared undifferentiated message when identity does not resolve, and creates no ticket", async () => {
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: false, reason: "no_contact" });

      const { POST } = await import("./route");
      const res = await POST(signedReq(ticketCreatedPayload()));
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe(UNIDENTIFIED_MESSAGE);
      expect(await prisma.techRequest.count()).toBe(0);
    });

    it("is idempotent: a retry of the same ticket.created event creates no second ticket", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });

      const { POST } = await import("./route");
      const first = await POST(signedReq(ticketCreatedPayload()));
      const firstJson = await first.json();
      const second = await POST(signedReq(ticketCreatedPayload()));
      const secondJson = await second.json();

      expect(firstJson.created).toBe(true);
      expect(secondJson.created).toBe(false);
      expect(secondJson.number).toBe(firstJson.number);
      expect(await prisma.techRequest.count()).toBe(1);
    });

    it("alerts IT only on first creation, not on an idempotent retry", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });

      const { POST } = await import("./route");
      await POST(signedReq(ticketCreatedPayload()));
      await POST(signedReq(ticketCreatedPayload()));

      expect(mocked(notifyTicketSubmitted)).toHaveBeenCalledTimes(1);
    });

    it("still creates the ticket and reports success when the number write-back to Intercom fails", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));

      const { POST } = await import("./route");
      const res = await POST(signedReq(ticketCreatedPayload()));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.created).toBe(true);
      const ticket = await prisma.techRequest.findUnique({ where: { number: json.number } });
      expect(ticket).not.toBeNull();
      expect(ticket?.intercomTicketId).toBe("ticket_1");
    });

    it("falls back to OTHER for an unrecognized Intercom ticket type rather than refusing the ticket", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });

      const { POST } = await import("./route");
      const res = await POST(signedReq(ticketCreatedPayload({ ticket_type: { name: "Some Future Ticket Type" } })));
      const json = await res.json();

      expect(res.status).toBe(200);
      const ticket = await prisma.techRequest.findUnique({ where: { number: json.number } });
      expect(ticket?.category).toBe("OTHER");
    });
  });

  describe("ticket.state.updated", () => {
    async function seedLinkedTicket(ticketId: string) {
      const res = await (await import("./route")).POST(signedReq(ticketCreatedPayload({ id: ticketId })));
      return res.json();
    }

    it("maps a known state to the right status and updates the ticket", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });
      await seedLinkedTicket("ticket_2");

      const { POST } = await import("./route");
      const res = await POST(signedReq(ticketStateUpdatedPayload("ticket_2", "In progress")));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.changed).toBe(true);
      const ticket = await prisma.techRequest.findUnique({ where: { intercomTicketId: "ticket_2" } });
      expect(ticket?.status).toBe("IN_PROGRESS");
    });

    it("rejects an unknown state, logs it, and leaves status unchanged", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });
      await seedLinkedTicket("ticket_3");

      const { POST } = await import("./route");
      const res = await POST(signedReq(ticketStateUpdatedPayload("ticket_3", "Some Brand New State")));

      expect(res.status).toBe(422);
      const ticket = await prisma.techRequest.findUnique({ where: { intercomTicketId: "ticket_3" } });
      expect(ticket?.status).toBe("SUBMITTED");
    });

    /**
     * 409, deliberately not 404. This route already answers 404 for "the
     * integration is not configured" (isWebhookConfigured, the first branch in
     * POST), so an unknown ticket id used to be indistinguishable from the
     * whole webhook receiver being switched off -- in Intercom's delivery
     * dashboard, which shows the status code and nothing else. The two want
     * opposite responses: re-check why this Intercom ticket has no Hub row, vs.
     * set the env vars. Asserted against the configured-off case in the same
     * test so the two can never quietly converge again (audit 14, finding 5).
     */
    it("409s for a ticket id it does not know about, a different code from the not-configured 404", async () => {
      const { POST } = await import("./route");
      const unknown = await POST(signedReq(ticketStateUpdatedPayload("never-created", "In progress")));
      expect(unknown.status).toBe(409);

      vi.stubEnv("INTERCOM_WEBHOOK_SECRET", "");
      const off = await POST(signedReq(ticketStateUpdatedPayload("never-created", "In progress")));
      expect(off.status).toBe(404);
      expect(unknown.status).not.toBe(off.status);
    });

    /**
     * Every sibling refusal on this path audits (unmapped_state, unverified
     * identity); this one only logged. It is also the refusal that means the
     * Hub and Intercom are actually out of sync, and the one whose repeat
     * occurrences are the signal -- a single hit can be a delivery-ordering
     * race, the same id twice is a permanently orphaned Intercom ticket. Logs
     * age out of retention and cannot be joined to anything (audit 14, finding
     * 5).
     */
    it("audits a ticket_not_found refusal rather than only logging it", async () => {
      const { POST } = await import("./route");
      await POST(signedReq(ticketStateUpdatedPayload("215475503912170", "In progress")));

      const rows = await prisma.auditLog.findMany({
        where: { action: "intercom_ticket_sync.ticket_not_found" },
      });
      expect(rows).toHaveLength(1);
      expect((rows[0].after as Record<string, unknown>).intercomTicketId).toBe("215475503912170");
    });

    // A webhook payload is serialized at whatever API version the Intercom app
    // is set to in the Developer Hub -- a dashboard setting this codebase does
    // not control, and one that can move backwards as easily as forwards. Both
    // shapes must therefore work, so this asserts the pre-2.12 one still does.
    it("also accepts the pre-2.12 flat state label", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });
      await seedLinkedTicket("ticket_5");

      const { POST } = await import("./route");
      const res = await POST(signedReq(legacyTicketStateUpdatedPayload("ticket_5", "In progress")));

      expect(res.status).toBe(200);
      const ticket = await prisma.techRequest.findUnique({ where: { intercomTicketId: "ticket_5" } });
      expect(ticket?.status).toBe("IN_PROGRESS");
    });

    // The state's CATEGORY is not its label: this workspace's "Resolved",
    // "Won't fix", and "Cancelled" all report category `resolved` while mapping
    // to three different Hub statuses. A payload carrying only the category
    // must refuse rather than resolve to whichever status happens to sit
    // nearest, which is the guess intercom-sync.ts is built to never make.
    it("refuses a payload carrying only the state category, and leaves status unchanged", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });
      await seedLinkedTicket("ticket_6");

      const { POST } = await import("./route");
      const res = await POST(
        signedReq({
          topic: "ticket.state.updated",
          data: { item: { type: "ticket", id: "ticket_6", ticket_state: "resolved" } },
        })
      );

      expect(res.status).toBe(400);
      const ticket = await prisma.techRequest.findUnique({ where: { intercomTicketId: "ticket_6" } });
      expect(ticket?.status).toBe("SUBMITTED");
    });

    // The loop-suppression claim, exercised at the HTTP layer: applying a
    // status change that arrived FROM Intercom must never turn around and
    // call Intercom back -- neither the note (notifyIntercomStatusChange,
    // Direction 2) nor the Ticket-state push (pushIntercomTicketState,
    // Direction 3's Hub-origin half). The service-level version of this test
    // (intercom-sync.test.ts) is the one that would actually catch a
    // regression that wires either of those into
    // applyIntercomTicketStateChange "for completeness" -- this one confirms
    // the route does not introduce its own additional outbound call either.
    it("does not call Intercom while applying an Intercom-originated status change", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });
      await seedLinkedTicket("ticket_4");
      (fetch as unknown as ReturnType<typeof vi.fn>).mockClear();

      const { POST } = await import("./route");
      await POST(signedReq(ticketStateUpdatedPayload("ticket_4", "Waiting on YNHH ITS")));

      expect(fetch).not.toHaveBeenCalled();
    });

    /**
     * Intercom does not guarantee delivery order and retries a failed delivery
     * for hours, so "arrived later" is not "happened later". The only guard
     * used to be status equality, which says nothing about age: an "In
     * progress" delivery that lost a race to a "Resolved" one silently dragged
     * the ticket backwards, and the reconciliation sweep would then report the
     * two systems disagreeing with no way to tell which side was stale (audit
     * 14, INT-3).
     */
    it("ignores a state change whose event timestamp predates the change already applied", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });
      await seedLinkedTicket("ticket_7");

      const { POST } = await import("./route");
      const newer = ticketStateUpdatedPayload("ticket_7", "Resolved") as Record<string, unknown>;
      newer.created_at = 1_760_000_100;
      const older = ticketStateUpdatedPayload("ticket_7", "In progress") as Record<string, unknown>;
      older.created_at = 1_760_000_000;

      expect((await POST(signedReq(newer))).status).toBe(200);
      const stale = await POST(signedReq(older));
      const json = await stale.json();

      // Accepted, not rejected: Intercom did nothing wrong sending it, and a
      // retry of a stale delivery would fail identically forever.
      expect(stale.status).toBe(200);
      expect(json.changed).toBe(false);
      expect(json.stale).toBe(true);
      const ticket = await prisma.techRequest.findUnique({ where: { intercomTicketId: "ticket_7" } });
      expect(ticket?.status).toBe("RESOLVED");
    });

    it("still applies a state change that arrives after the one already applied", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });
      await seedLinkedTicket("ticket_8");

      const { POST } = await import("./route");
      const first = ticketStateUpdatedPayload("ticket_8", "In progress") as Record<string, unknown>;
      first.created_at = 1_760_000_000;
      const second = ticketStateUpdatedPayload("ticket_8", "Resolved") as Record<string, unknown>;
      second.created_at = 1_760_000_100;

      await POST(signedReq(first));
      const res = await POST(signedReq(second));

      expect(res.status).toBe(200);
      expect((await res.json()).changed).toBe(true);
      const ticket = await prisma.techRequest.findUnique({ where: { intercomTicketId: "ticket_8" } });
      expect(ticket?.status).toBe("RESOLVED");
    });
  });

  /**
   * The refusal branch's whole reason to exist is answering "which fields did
   * Intercom actually send" for a sync that is otherwise silent. It could not:
   * it described `data.item` AFTER WebhookEnvelopeSchema had stripped the
   * payload down to the two keys it declares, so a payload that carried the
   * ticket anywhere else produced `Object.keys({}).join(",")` -- an empty
   * string, and a PostHog log line with an empty attribute map. That is exactly
   * what the four production refusals on 2026-08-13 carried (audit 14, finding
   * 1).
   */
  describe("ticket.state.updated refusal diagnostics", () => {
    it("names the keys Intercom really sent, including the ones the envelope schema strips", async () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { POST } = await import("./route");
      const res = await POST(
        signedReq({
          topic: "ticket.state.updated",
          id: "notif_01K",
          app_id: "unyx5lb2",
          created_at: 1_760_000_000,
          // The ticket is somewhere other than data.item -- the one payload
          // shape that most needs explaining, and the one the old diagnostic
          // was structurally unable to describe.
          data: { type: "notification_event_data", ticket: { id: "215475503912170" } },
        })
      );

      expect(res.status).toBe(400);
      const attrs = warnAttrs(spy, MISSING_FIELDS_MESSAGE);
      expect(attrs).toBeDefined();
      expect(attrs?.envelopeKeys).toContain("app_id");
      expect(attrs?.dataKeys).toContain("ticket");
      expect(attrs?.itemKeys).toBe("(absent)");
    });

    // "Intercom sent no item" and "Intercom sent an item with no fields" are
    // different bugs with different fixes, and an empty string cannot tell them
    // apart -- nor apart from "the diagnostic itself is broken", which is what
    // it actually meant.
    it("tells an absent item apart from a present but empty one", async () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { POST } = await import("./route");

      await POST(signedReq({ topic: "ticket.state.updated", data: {} }));
      expect(warnAttrs(spy, MISSING_FIELDS_MESSAGE)?.itemKeys).toBe("(absent)");

      spy.mockClear();
      await POST(signedReq({ topic: "ticket.state.updated", data: { item: {} } }));
      expect(warnAttrs(spy, MISSING_FIELDS_MESSAGE)?.itemKeys).toBe("(none)");
    });

    // ticket_state is the field the 2.12 serialization change moved, and the
    // one that already cost this integration a silent outage. Its shape, in key
    // form, turns "the label is missing" into "Intercom nested it somewhere
    // new" without a second deploy to find out.
    it("names which required field was missing and the shape of ticket_state", async () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { POST } = await import("./route");
      await POST(
        signedReq({
          topic: "ticket.state.updated",
          data: { item: { type: "ticket", id: "215475503912170", ticket_state: { category: "resolved" } } },
        })
      );

      const attrs = warnAttrs(spy, MISSING_FIELDS_MESSAGE);
      expect(attrs?.missing).toBe("state");
      expect(attrs?.ticketStateKeys).toBe("category");
    });

    // A ticket payload carries the member's own words in
    // ticket_attributes._default_title_/_default_description_, and this log
    // ships to PostHog. Keys are the most that may be reported here.
    it("reports keys only, never the member-authored text the payload carries", async () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { POST } = await import("./route");
      await POST(
        signedReq({
          topic: "ticket.state.updated",
          data: {
            item: {
              type: "ticket",
              ticket_attributes: {
                _default_title_: "PRIVATE-SUBJECT-TEXT",
                _default_description_: "PRIVATE-BODY-TEXT",
              },
            },
          },
        })
      );

      const attrs = warnAttrs(spy, MISSING_FIELDS_MESSAGE);
      expect(attrs?.itemKeys).toContain("ticket_attributes");
      expect(JSON.stringify(attrs)).not.toContain("PRIVATE-SUBJECT-TEXT");
      expect(JSON.stringify(attrs)).not.toContain("PRIVATE-BODY-TEXT");
    });
  });

  /**
   * The Direction-3 link ticket.created used to sever (audit 14, SUP-1/INT-1).
   * A ticket Fin opened through the from-conversation route has a conversation
   * id and nothing else, because no Intercom Ticket exists at that moment. When
   * Intercom later converts that conversation into a Ticket, ticket.created
   * fires with the SAME id -- and this handler used to find the existing row
   * and return early without writing intercomTicketId. Nothing else in the
   * codebase ever wrote that column, so the ticket silently stopped receiving
   * Intercom state changes forever, and the reconciliation sweep (which filters
   * on that same column) could not even see it to report the drift.
   */
  describe("ticket.created back-fills the Intercom ticket id", () => {
    async function seedFinTicket(personId: string, conversationId: string) {
      const { ticket } = await createTechRequestFromConversation(personId, {
        intercomConversationId: conversationId,
        category: "GENERAL_IT",
        subject: "Wifi won't connect",
        description: "Dropping every few minutes on the clinic floor.",
      });
      expect(ticket.intercomTicketId).toBeNull();
      return ticket;
    }

    it("links an existing conversation-only ticket instead of returning early", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });
      const seeded = await seedFinTicket(person.id, "conv_promoted");

      const { POST } = await import("./route");
      const res = await POST(signedReq(ticketCreatedPayload({ id: "conv_promoted" })));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.created).toBe(false);
      expect(json.linked).toBe(true);
      expect(json.number).toBe(seeded.number);
      const reloaded = await prisma.techRequest.findUniqueOrThrow({ where: { id: seeded.id } });
      expect(reloaded.intercomTicketId).toBe("conv_promoted");
      expect(await prisma.techRequest.count()).toBe(1);
    });

    // The consequence that actually mattered: without the back-fill this state
    // change lands on ticket_not_found forever, which is the production
    // symptom the audit started from.
    it("makes the ticket reachable by ticket.state.updated, which is the link that was lost", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });
      const seeded = await seedFinTicket(person.id, "conv_promoted");

      const { POST } = await import("./route");
      await POST(signedReq(ticketCreatedPayload({ id: "conv_promoted" })));
      const res = await POST(signedReq(ticketStateUpdatedPayload("conv_promoted", "In progress")));

      expect(res.status).toBe(200);
      const reloaded = await prisma.techRequest.findUniqueOrThrow({ where: { id: seeded.id } });
      expect(reloaded.status).toBe("IN_PROGRESS");
    });

    // This delivery is the FIRST moment an Intercom Ticket exists to carry the
    // number, so it is the first moment the write-back is possible at all --
    // see pushTicketNumber's doc comment on why the conversation id could never
    // reach that attribute.
    it("writes the Hub ticket number onto the Intercom ticket now that one exists", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });
      const seeded = await seedFinTicket(person.id, "conv_promoted");
      (fetch as unknown as ReturnType<typeof vi.fn>).mockClear();

      const { POST } = await import("./route");
      await POST(signedReq(ticketCreatedPayload({ id: "conv_promoted" })));

      const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(String(call?.[0])).toContain("/tickets/conv_promoted");
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
        ticket_attributes: { "Hub ticket number": seeded.number },
      });
    });

    // A back-fill is not a new ticket: IT was already paged when Fin created
    // it, and paging every manager again for the same request is exactly what
    // the created-only guard exists to prevent.
    it("does not re-alert IT when it only links an existing ticket", async () => {
      const person = await createPerson("Sam Rivera");
      mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: true, personId: person.id, name: person.name });
      await seedFinTicket(person.id, "conv_promoted");

      const { POST } = await import("./route");
      await POST(signedReq(ticketCreatedPayload({ id: "conv_promoted" })));

      expect(mocked(notifyTicketSubmitted)).not.toHaveBeenCalled();
    });
  });
});
