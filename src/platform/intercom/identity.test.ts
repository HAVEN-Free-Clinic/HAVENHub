import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// findMemberRecordByClaim is mocked here only so this file's module graph
// resolves; the email fallback that calls it is never opted into below. Its
// real behavior -- the Yale-domain gate that decides whether an emailed address
// may name a Person at all -- is exercised against a real database in
// identity.email-fallback.test.ts, because a mock of that function cannot fail
// the way a wrong gate would.
vi.mock("@/platform/auth/match-person", () => ({
  getActivePerson: vi.fn(),
  findMemberRecordByClaim: vi.fn(),
}));

import { findMemberRecordByClaim, getActivePerson } from "@/platform/auth/match-person";
import {
  resolveIntercomIdentity,
  resolveIdentityFromConversation,
  INTERCOM_LOOKUP_TIMEOUT_MS,
} from "./identity";

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

    expect(result).toEqual({ ok: true, personId: "p1", name: "Sam Rivera", via: "external_id" });
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

  /**
   * Fin waits on this call synchronously, so a hung Intercom request must not
   * hang the whole tool call -- see INTERCOM_LOOKUP_TIMEOUT_MS's doc comment.
   * A never-resolving fetch that honors its AbortSignal is the closest
   * simulation of a genuinely stuck request without an actual network wait.
   */
  it("fails closed when the fetch times out", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      )
    );

    const pending = resolveIntercomIdentity("p1");
    await vi.advanceTimersByTimeAsync(INTERCOM_LOOKUP_TIMEOUT_MS);
    const result = await pending;

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
    vi.useRealTimers();
  });
});

/** Conversation-shaped fetch stub: Intercom nests contacts one level deep. */
function mockConversationOnce(
  status: number,
  contacts: Array<{ id?: string | null; external_id?: string | null }>
) {
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

    expect(result).toEqual({ ok: true, personId: "p1", name: "Sam Rivera", via: "external_id" });
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

  /**
   * The production shape that motivated the fallback (2026-08-16): Intercom
   * stamps a lead it auto-created from an inbound email with an external_id of
   * its OWN -- a UUID -- so the "no external_id" guard above never fires and
   * getActivePerson is handed a value that cannot name a Person. Without opting
   * in, this must still refuse, and must not go looking for a second way to
   * identify the sender.
   */
  it("refuses an Intercom-generated external_id, and does not reach for the email fallback unless asked", async () => {
    mockConversationOnce(200, [{ id: "c1", external_id: "d7aa2e5b-0a02-4e06-b8d9-36ff176d80fb" }]);
    mocked(getActivePerson).mockResolvedValue(null);

    const result = await resolveIdentityFromConversation("conv_1");

    expect(result).toEqual({ ok: false, reason: "unknown_person" });
    expect(mocked(findMemberRecordByClaim)).not.toHaveBeenCalled();
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
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

  /** See the matching test on resolveIntercomIdentity for why this is simulated this way. */
  it("fails closed when the fetch times out", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      )
    );

    const pending = resolveIdentityFromConversation("conv_1");
    await vi.advanceTimersByTimeAsync(INTERCOM_LOOKUP_TIMEOUT_MS);
    const result = await pending;

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
    vi.useRealTimers();
  });
});
