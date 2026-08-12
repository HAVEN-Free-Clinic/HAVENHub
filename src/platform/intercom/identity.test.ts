import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));

import { getActivePerson } from "@/platform/auth/match-person";
import { resolveIntercomIdentity, resolveIdentityFromConversation } from "./identity";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveIntercomIdentity", () => {
  it("resolves when the contact's external_id matches and the person is active", async () => {
    mockFetchOnce(200, { external_id: "p1" });
    mocked(getActivePerson).mockResolvedValue({ id: "p1", name: "Sam Rivera" });

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: true, personId: "p1", name: "Sam Rivera" });
  });

  it("refuses when Intercom returns a contact for a different external_id", async () => {
    mockFetchOnce(200, { external_id: "someone-else" });
    mocked(getActivePerson).mockResolvedValue({ id: "p1", name: "Sam Rivera" });

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "unverified" });
  });

  it("refuses when Intercom has no such contact", async () => {
    mockFetchOnce(404, {});

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "unverified" });
  });

  it("fails closed when Intercom returns a non-404 error like 401 (revoked token)", async () => {
    mockFetchOnce(401, {});

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
  });

  it("refuses an offboarded person even though Intercom still knows the contact", async () => {
    mockFetchOnce(200, { external_id: "p1" });
    mocked(getActivePerson).mockResolvedValue(null);

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "unknown_person" });
  });

  it("fails closed when the Intercom lookup throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
  });

  it("fails closed when no access token is configured", async () => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "");

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
  });

  it("pins an explicit Intercom-Version header rather than trusting the workspace default", async () => {
    mockFetchOnce(200, { external_id: "p1" });
    mocked(getActivePerson).mockResolvedValue({ id: "p1", name: "Sam Rivera" });

    await resolveIntercomIdentity("p1");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Intercom-Version"]).toBe("2.14");
  });

  it("fails closed distinctly on a merged contact (410), rather than folding it into a generic lookup failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 410,
        headers: { get: (name: string) => (name.toLowerCase() === "link" ? '<https://api.intercom.io/contacts/canonical-id>; rel="canonical"' : null) },
        json: async () => ({}),
      })
    );

    const result = await resolveIntercomIdentity("p1");

    // Still fail-closed like any other lookup failure -- the distinction the
    // fix makes is in how it is logged (see identity.ts), not the outcome.
    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
  });
});

/** Conversation-shaped fetch stub: Intercom nests contacts one level deep. */
function mockConversationOnce(status: number, contacts: Array<{ external_id?: string | null }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => ({ contacts: { type: "contact.list", contacts } }),
    })
  );
}

describe("resolveIdentityFromConversation", () => {
  it("resolves the member who owns the conversation", async () => {
    mockConversationOnce(200, [{ external_id: "p1" }]);
    mocked(getActivePerson).mockResolvedValue({ id: "p1", name: "Sam Rivera" });

    const result = await resolveIdentityFromConversation("conv_1");

    expect(result).toEqual({ ok: true, personId: "p1", name: "Sam Rivera" });
  });

  it("asks Intercom who owns the conversation rather than trusting an asserted id", async () => {
    mockConversationOnce(200, [{ external_id: "p1" }]);
    mocked(getActivePerson).mockResolvedValue({ id: "p1", name: null });

    await resolveIdentityFromConversation("conv_1");

    const [url, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/conversations/conv_1");
    expect((init as RequestInit).headers).toMatchObject({ "Intercom-Version": "2.14" });
  });

  /**
   * Intercom really does return conversations with no contacts (observed in the
   * live workspace), so this is a routine input, not a hypothetical. The reason
   * is "no_contact", distinct from "unverified" (the 404 case below), so the
   * audit trail can tell "no such conversation" apart from "conversation
   * exists but has no single resolvable contact" -- see recordToolCall.
   */
  it("refuses a conversation with no contacts", async () => {
    mockConversationOnce(200, []);

    const result = await resolveIdentityFromConversation("conv_1");

    expect(result).toEqual({ ok: false, reason: "no_contact" });
    expect(mocked(getActivePerson)).not.toHaveBeenCalled();
  });

  it("refuses a conversation with several contacts rather than guessing which one", async () => {
    mockConversationOnce(200, [{ external_id: "p1" }, { external_id: "p2" }]);

    const result = await resolveIdentityFromConversation("conv_1");

    expect(result).toEqual({ ok: false, reason: "no_contact" });
    expect(mocked(getActivePerson)).not.toHaveBeenCalled();
  });

  it("refuses a contact that never booted our Messenger, so has no external_id", async () => {
    mockConversationOnce(200, [{ external_id: null }]);

    const result = await resolveIdentityFromConversation("conv_1");

    expect(result).toEqual({ ok: false, reason: "no_contact" });
  });

  it("refuses an unknown conversation, which is what a swapped id looks like", async () => {
    mockConversationOnce(404, []);

    const result = await resolveIdentityFromConversation("conv_nope");

    expect(result).toEqual({ ok: false, reason: "unverified" });
  });

  it("refuses an offboarded member even though the conversation still resolves", async () => {
    mockConversationOnce(200, [{ external_id: "p1" }]);
    mocked(getActivePerson).mockResolvedValue(null);

    const result = await resolveIdentityFromConversation("conv_1");

    expect(result).toEqual({ ok: false, reason: "unknown_person" });
  });

  it("fails closed when the lookup errors", async () => {
    mockConversationOnce(500, []);

    const result = await resolveIdentityFromConversation("conv_1");

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
  });

  it("fails closed when the network throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await resolveIdentityFromConversation("conv_1");

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
  });

  it("fails closed when no access token is configured", async () => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "");

    const result = await resolveIdentityFromConversation("conv_1");

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
  });
});
