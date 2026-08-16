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

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

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

    it("404s for a ticket id it does not know about", async () => {
      const { POST } = await import("./route");
      const res = await POST(signedReq(ticketStateUpdatedPayload("never-created", "In progress")));

      expect(res.status).toBe(404);
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
  });
});
