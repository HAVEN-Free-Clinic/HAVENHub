import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

// Real identity.ts (UNIDENTIFIED_MESSAGE, types) EXCEPT resolveIdentityFromConversation,
// which every test below drives directly rather than exercising the real
// Intercom HTTP lookup -- that lookup already has its own coverage in
// identity.test.ts.
vi.mock("@/platform/intercom/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/intercom/identity")>();
  return { ...actual, resolveIdentityFromConversation: vi.fn() };
});

// Stubbed so the notification fan-out can be asserted without rendering
// templates or touching the email queue. Its own behaviour (which half is
// suppressed for a linked ticket) is covered in notifications.test.ts; what
// matters here is only that this route calls it at all.
vi.mock("@/modules/support/services/notifications", () => ({
  notifyTicketSubmitted: vi.fn(),
}));

import { resolveIdentityFromConversation, UNIDENTIFIED_MESSAGE } from "@/platform/intercom/identity";
import { notifyTicketSubmitted } from "@/modules/support/services/notifications";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

/** All four env vars set = the shared Intercom connector surface is on. */
function configure() {
  vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
  vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
  vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
  vi.stubEnv("INTERCOM_MCP_BEARER_TOKEN", "bearer-token");
}

const AUTHED = { Authorization: "Bearer bearer-token", "Content-Type": "application/json" };

function req(body: unknown, headers: Record<string, string> = AUTHED) {
  return new Request("https://hub.test/api/support/tickets/from-conversation", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function createPerson(name: string) {
  return prisma.person.create({ data: { name, status: "ACTIVE" } });
}

const VALID_BODY = {
  conversationId: "conv_123",
  category: "GENERAL_IT",
  subject: "Wifi won't connect",
  description: "Dropping every few minutes on the clinic floor.",
};

describe("POST /api/support/tickets/from-conversation", () => {
  beforeEach(async () => {
    await resetDb();
    vi.resetAllMocks();
    configure();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("404s when the Intercom connector is not configured", async () => {
    vi.stubEnv("INTERCOM_MCP_BEARER_TOKEN", "");
    const { POST } = await import("./route");
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(404);
  });

  it("401s when the bearer token is missing", async () => {
    const { POST } = await import("./route");
    const res = await POST(req(VALID_BODY, { "Content-Type": "application/json" }));
    expect(res.status).toBe(401);
  });

  it("401s when the bearer token is wrong", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      req(VALID_BODY, { Authorization: "Bearer wrong-token", "Content-Type": "application/json" })
    );
    expect(res.status).toBe(401);
  });

  it("400s on a malformed body", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ conversationId: "conv_123" }));
    expect(res.status).toBe(400);
  });

  it("refuses with the shared undifferentiated message when identity does not resolve, and audits it", async () => {
    mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: false, reason: "no_contact" });

    const { POST } = await import("./route");
    const res = await POST(req(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe(UNIDENTIFIED_MESSAGE);

    const rows = await prisma.auditLog.findMany({ where: { action: "intercom_ticket_sync.unverified" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].actorPersonId).toBeNull();
    expect((rows[0].after as Record<string, unknown>).reason).toBe("no_contact");

    // No ticket should ever be created on a refused request.
    expect(await prisma.techRequest.count()).toBe(0);
  });

  it("creates a SUBMITTED ticket owned by the person resolved from the conversation", async () => {
    const person = await createPerson("Sam Rivera");
    mocked(resolveIdentityFromConversation).mockResolvedValue({
      ok: true,
      personId: person.id,
      name: person.name,
    });

    const { POST } = await import("./route");
    const res = await POST(req(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.created).toBe(true);
    expect(typeof json.number).toBe("number");

    const ticket = await prisma.techRequest.findUnique({ where: { number: json.number } });
    expect(ticket?.requesterId).toBe(person.id);
    expect(ticket?.status).toBe("SUBMITTED");
    expect(ticket?.intercomConversationId).toBe("conv_123");
  });

  // The idempotency test: the failure it guards against is a flaky Intercom
  // retry silently minting a second ticket with a consecutive number, leaving
  // IT with two rows and no way to tell which one is real.
  it("is idempotent: the same conversationId twice creates exactly one ticket and returns the same number", async () => {
    const person = await createPerson("Sam Rivera");
    mocked(resolveIdentityFromConversation).mockResolvedValue({
      ok: true,
      personId: person.id,
      name: person.name,
    });

    const { POST } = await import("./route");
    const first = await POST(req(VALID_BODY));
    const firstJson = await first.json();
    const second = await POST(req(VALID_BODY));
    const secondJson = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstJson.created).toBe(true);
    expect(secondJson.created).toBe(false);
    expect(secondJson.number).toBe(firstJson.number);
    expect(await prisma.techRequest.count()).toBe(1);
  });

  /**
   * Without this, a ticket opened through Fin reaches nobody in IT: the
   * notification fan-out was wired only to the Hub form, so a chat-originated
   * ticket would sit in /support/all until somebody happened to look, which
   * for a support queue is indistinguishable from losing it.
   */
  it("tells IT a ticket arrived, so a chat-originated ticket is not silently queued", async () => {
    const person = await createPerson("Sam Rivera");
    mocked(resolveIdentityFromConversation).mockResolvedValue({
      ok: true,
      personId: person.id,
      name: person.name,
    });

    const { POST } = await import("./route");
    await POST(req(VALID_BODY));

    expect(mocked(notifyTicketSubmitted)).toHaveBeenCalledTimes(1);
    const [, ticketArg] = mocked(notifyTicketSubmitted).mock.calls[0];
    expect(ticketArg.intercomConversationId).toBe(VALID_BODY.conversationId);
  });

  it("does not re-alert on an idempotent retry, so Intercom retries cannot page IT repeatedly", async () => {
    const person = await createPerson("Sam Rivera");
    mocked(resolveIdentityFromConversation).mockResolvedValue({
      ok: true,
      personId: person.id,
      name: person.name,
    });

    const { POST } = await import("./route");
    await POST(req(VALID_BODY));
    await POST(req(VALID_BODY));

    expect(mocked(notifyTicketSubmitted)).toHaveBeenCalledTimes(1);
  });

  it("ignores a requester id carried in the body and uses the identity resolved from the conversation instead", async () => {
    const requester = await createPerson("Sam Rivera");
    const impersonated = await createPerson("Someone Else");
    mocked(resolveIdentityFromConversation).mockResolvedValue({
      ok: true,
      personId: requester.id,
      name: requester.name,
    });

    const { POST } = await import("./route");
    const res = await POST(req({ ...VALID_BODY, requesterId: impersonated.id, personId: impersonated.id }));
    const json = await res.json();

    expect(res.status).toBe(200);
    const ticket = await prisma.techRequest.findUnique({ where: { number: json.number } });
    expect(ticket?.requesterId).toBe(requester.id);
    expect(ticket?.requesterId).not.toBe(impersonated.id);
  });

  it("accepts EPIC as a category but never persists any Epic intake field from the body", async () => {
    const person = await createPerson("Sam Rivera");
    mocked(resolveIdentityFromConversation).mockResolvedValue({
      ok: true,
      personId: person.id,
      name: person.name,
    });

    const { POST } = await import("./route");
    const res = await POST(
      req({
        conversationId: "conv_epic",
        category: "EPIC",
        subject: "Need Epic access",
        description: "New volunteer starting Monday.",
        govId: "123-45-6789",
        netId: "abc12",
        epicJobTitle: "Volunteer",
        epicMirrorId: "MIRROR1",
        epicStartDate: "2026-09-01",
        epicEndDate: "2027-05-01",
        worksAtYnhh: true,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    const ticket = await prisma.techRequest.findUnique({ where: { number: json.number } });
    expect(ticket?.category).toBe("EPIC");
    expect(ticket?.govId).toBeNull();
    expect(ticket?.netId).toBeNull();
    expect(ticket?.epicJobTitle).toBeNull();
    expect(ticket?.epicMirrorId).toBeNull();
    expect(ticket?.epicStartDate).toBeNull();
    expect(ticket?.epicEndDate).toBeNull();
    expect(ticket?.worksAtYnhh).toBeNull();
  });

  it("returns 503 when the database is unreachable", async () => {
    const person = await createPerson("Sam Rivera");
    mocked(resolveIdentityFromConversation).mockResolvedValue({
      ok: true,
      personId: person.id,
      name: person.name,
    });
    const spy = vi
      .spyOn(prisma.techRequest, "findUnique")
      .mockRejectedValue(
        new Prisma.PrismaClientInitializationError(
          "Can't reach database server at ep-broad-brook.neon.tech:5432",
          "5.0.0"
        )
      );

    const { POST } = await import("./route");
    const res = await POST(req(VALID_BODY));

    expect(res.status).toBe(503);
    spy.mockRestore();
  });
});
