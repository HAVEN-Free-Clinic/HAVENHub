/**
 * The email fallback in resolveIdentityFromConversation, exercised against a
 * REAL database and the REAL match-person module.
 *
 * Deliberately a separate file from identity.test.ts, which mocks
 * "@/platform/auth/match-person" wholesale. Every interesting question about
 * this fallback is a question about that module's trust gate -- may an address
 * asserted in an email name this Person at all? -- and a mocked
 * findMemberRecordByClaim answers whatever the test told it to. A test like
 * that passes just as green against a fallback with no gate whatsoever, which
 * makes it worthless for the one property that matters here.
 *
 * So: nothing below is mocked except `fetch`. The Person rows are real, the
 * Yale-domain gate is the real one, and the status gate is the real one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveIdentityFromConversation } from "./identity";

/**
 * The exact contact shape Intercom auto-creates for an inbound email from
 * someone it has not seen before: role "lead", and an external_id Intercom
 * generated itself. Verified against the live workspace on 2026-08-16 (contact
 * 6a811139dd364472c5847425 on ticket 215475503912170). A UUID here rather than
 * a placeholder string is the point of the fixture -- it is what slips past the
 * "a contact with no external_id never booted our Messenger" guard.
 */
const INTERCOM_GENERATED_EXTERNAL_ID = "d7aa2e5b-0a02-4e06-b8d9-36ff176d80fb";

type StubbedResponse = { status: number; body: unknown };

/**
 * Queues responses in call order: the conversation lookup first, then the
 * contact lookup the fallback makes. A call past the end of the queue rejects,
 * so a test that expects only one request fails loudly if a second is made.
 */
function mockFetchSequence(...responses: StubbedResponse[]) {
  const fn = vi.fn().mockRejectedValue(new Error("unexpected extra fetch"));
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => null },
      json: async () => r.body,
    });
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

function conversationWith(contact: { id?: string | null; external_id?: string | null }): StubbedResponse {
  return { status: 200, body: { contacts: { type: "contact.list", contacts: [contact] } } };
}

function contactWithEmail(email: string | null): StubbedResponse {
  return { status: 200, body: { type: "contact", role: "lead", email } };
}

/** The lead Intercom builds from an inbound email: an id to fetch, a UUID external_id. */
const EMAIL_LEAD = { id: "6a811139dd364472c5847425", external_id: INTERCOM_GENERATED_EXTERNAL_ID };

const WITH_FALLBACK = { allowVerifiedEmailFallback: true };

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveIdentityFromConversation email fallback", () => {
  it("resolves the member behind an email-created lead, by the Yale address on their record", async () => {
    const person = await prisma.person.create({
      data: { name: "Tobias Liu", status: "ACTIVE", contactEmail: "tobias.liu@yale.edu" },
    });
    mockFetchSequence(conversationWith(EMAIL_LEAD), contactWithEmail("tobias.liu@yale.edu"));

    const result = await resolveIdentityFromConversation("215475503912170", WITH_FALLBACK);

    expect(result).toEqual({ ok: true, personId: person.id, name: "Tobias Liu", via: "verified_email" });
  });

  it("fetches the contact to get that address, because the conversation payload does not carry one", async () => {
    await prisma.person.create({
      data: { name: "Tobias Liu", status: "ACTIVE", contactEmail: "tobias.liu@yale.edu" },
    });
    const fetchMock = mockFetchSequence(conversationWith(EMAIL_LEAD), contactWithEmail("tobias.liu@yale.edu"));

    await resolveIdentityFromConversation("215475503912170", WITH_FALLBACK);

    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(fetchMock.mock.calls[1][0]).toContain("/contacts/6a811139dd364472c5847425");
  });

  it("resolves a member who wrote from their NetID address, which is on no contactEmail anywhere", async () => {
    const person = await prisma.person.create({
      data: { name: "Tobias Liu", status: "ACTIVE", netId: "tl729", contactEmail: null },
    });
    mockFetchSequence(conversationWith(EMAIL_LEAD), contactWithEmail("tl729@yale.edu"));

    const result = await resolveIdentityFromConversation("215475503912170", WITH_FALLBACK);

    expect(result).toEqual({ ok: true, personId: person.id, name: "Tobias Liu", via: "verified_email" });
  });

  /**
   * THE load-bearing test. An emailed `From:` is asserted by whoever sent the
   * mail, so the only thing keeping this fallback from being "name any Person
   * whose stored address you can guess" is match-person's rule that an email
   * claim counts only when the CLAIM is Yale-asserted. A stored personal
   * address must stay unreachable this way even when the incoming address
   * matches it exactly.
   */
  it("refuses a non-Yale sender even when the address matches a member's stored contact email exactly", async () => {
    await prisma.person.create({
      data: { name: "Tobias Liu", status: "ACTIVE", contactEmail: "tobias.liu@gmail.com" },
    });
    mockFetchSequence(conversationWith(EMAIL_LEAD), contactWithEmail("tobias.liu@gmail.com"));

    const result = await resolveIdentityFromConversation("215475503912170", WITH_FALLBACK);

    expect(result).toEqual({ ok: false, reason: "unknown_person" });
  });

  it("refuses an offboarded member whose old Yale address is still on the Intercom contact", async () => {
    await prisma.person.create({
      data: { name: "Tobias Liu", status: "OFFBOARDED", contactEmail: "tobias.liu@yale.edu" },
    });
    mockFetchSequence(conversationWith(EMAIL_LEAD), contactWithEmail("tobias.liu@yale.edu"));

    const result = await resolveIdentityFromConversation("215475503912170", WITH_FALLBACK);

    expect(result).toEqual({ ok: false, reason: "unknown_person" });
  });

  it("refuses a Yale address belonging to nobody in the Hub", async () => {
    mockFetchSequence(conversationWith(EMAIL_LEAD), contactWithEmail("someone.else@yale.edu"));

    const result = await resolveIdentityFromConversation("215475503912170", WITH_FALLBACK);

    expect(result).toEqual({ ok: false, reason: "unknown_person" });
  });

  it("refuses a contact Intercom holds no address for at all", async () => {
    mockFetchSequence(conversationWith(EMAIL_LEAD), contactWithEmail(null));

    const result = await resolveIdentityFromConversation("215475503912170", WITH_FALLBACK);

    expect(result).toEqual({ ok: false, reason: "unknown_person" });
  });

  /**
   * The other shape the fallback has to cover: a contact with no external_id
   * whatsoever, which is what the original guard assumed every lead looked
   * like. It still refuses as "no_contact" when nothing matches, so the audit
   * trail keeps telling the two shapes apart.
   */
  it("also resolves a contact carrying no external_id at all", async () => {
    const person = await prisma.person.create({
      data: { name: "Tobias Liu", status: "ACTIVE", contactEmail: "tobias.liu@yale.edu" },
    });
    mockFetchSequence(
      conversationWith({ id: "6a811139dd364472c5847425", external_id: null }),
      contactWithEmail("tobias.liu@yale.edu")
    );

    const result = await resolveIdentityFromConversation("215475503912170", WITH_FALLBACK);

    expect(result).toEqual({ ok: true, personId: person.id, name: "Tobias Liu", via: "verified_email" });
  });

  it("still reports no_contact, not unknown_person, when a contact with no external_id matches nobody", async () => {
    mockFetchSequence(
      conversationWith({ id: "6a811139dd364472c5847425", external_id: null }),
      contactWithEmail("someone.else@yale.edu")
    );

    const result = await resolveIdentityFromConversation("215475503912170", WITH_FALLBACK);

    expect(result).toEqual({ ok: false, reason: "no_contact" });
  });

  /**
   * A failure to REACH Intercom must not be reported as a permanent refusal.
   * The webhook caller stops retrying on a permanent one, so folding an outage
   * into "not a member" would silently drop a real member's ticket.
   */
  it("reports lookup_failed when the contact fetch errors, so the caller keeps retrying", async () => {
    await prisma.person.create({
      data: { name: "Tobias Liu", status: "ACTIVE", contactEmail: "tobias.liu@yale.edu" },
    });
    mockFetchSequence(conversationWith(EMAIL_LEAD), { status: 500, body: {} });

    const result = await resolveIdentityFromConversation("215475503912170", WITH_FALLBACK);

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
  });

  it("reports lookup_failed when the contact fetch throws", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("network down"));
    fn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => conversationWith(EMAIL_LEAD).body,
    });
    vi.stubGlobal("fetch", fn);

    const result = await resolveIdentityFromConversation("215475503912170", WITH_FALLBACK);

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
  });

  it("treats a contact Intercom no longer has (404) as a real answer, not an outage", async () => {
    mockFetchSequence(conversationWith(EMAIL_LEAD), { status: 404, body: {} });

    const result = await resolveIdentityFromConversation("215475503912170", WITH_FALLBACK);

    expect(result).toEqual({ ok: false, reason: "unknown_person" });
  });

  it("never fetches the contact, and refuses, when the caller has not opted in", async () => {
    await prisma.person.create({
      data: { name: "Tobias Liu", status: "ACTIVE", contactEmail: "tobias.liu@yale.edu" },
    });
    const fetchMock = mockFetchSequence(conversationWith(EMAIL_LEAD));

    const result = await resolveIdentityFromConversation("215475503912170");

    expect(result).toEqual({ ok: false, reason: "unknown_person" });
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("prefers the external_id path and skips the fallback entirely when it resolves", async () => {
    const person = await prisma.person.create({
      data: { name: "Sam Rivera", status: "ACTIVE", contactEmail: "tobias.liu@yale.edu" },
    });
    const fetchMock = mockFetchSequence(
      conversationWith({ id: "6a811139dd364472c5847425", external_id: person.id })
    );

    const result = await resolveIdentityFromConversation("215475503912170", WITH_FALLBACK);

    expect(result).toEqual({ ok: true, personId: person.id, name: "Sam Rivera", via: "external_id" });
    expect(fetchMock.mock.calls).toHaveLength(1);
  });
});
