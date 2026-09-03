import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * THE ALLOWLIST THESE TESTS ROUTE AGAINST, stated here rather than borrowed.
 *
 * What this file tests is ROUTING: which transport a From domain is handed to,
 * and what each transport does with a From it may or may not sign. None of that
 * is a claim about which real domain is signable by whom, and all of it has to
 * keep working whichever way that business fact points.
 *
 * It used to borrow the shipped table anyway, with yale.edu standing in for both
 * "a domain Maileroo cannot sign" and "a Graph-signable domain", and
 * havenfreeclinic.org for "a domain Maileroo can sign". That made every routing
 * test depend on a Maileroo dashboard state. On 2026-09-02 the dashboard
 * changed: Maileroo verified yale.edu, DEFAULT_SENDING_DOMAINS flipped that row
 * to maileroo, and eleven tests here went red at once, several of them named for
 * routing to Graph. Renaming their expectations to "maileroo" would have left
 * tests whose name and body disagree, passing while checking nothing.
 *
 * So each shape is named for the shape it is and pinned by SENDING_DOMAINS, the
 * same override an operator pulls. `.example` is reserved by RFC 2606 and can
 * never become a real sending domain, so nothing below can quietly start meaning
 * something about production again. In particular the GRAPH branch stays
 * genuinely exercised, which matters because "SENDING_DOMAINS=<domain>:graph" is
 * the documented reversal lever: no domain routes to Graph by default today, and
 * these are the tests that have to still mean something the day one does.
 *
 * Set through the environment rather than by mocking ./sending-domains so the
 * whole real chain still runs underneath: config.ts's format check,
 * parseSendingDomains, and the module-level map signingTransportFor reads. What
 * the SHIPPED table says, and that an override reaches this far at all, are
 * sending-domains.test.ts's job, not this file's.
 *
 * vitest.setup.ts re-claims SENDING_DOMAINS as "" before every test file, so
 * this cannot leak into a file that expects the shipped default.
 */
const { MAILEROO_DOMAIN, GRAPH_DOMAIN, UNLISTED_DOMAIN, GRAPH_PINNED_FROM } = vi.hoisted(() => {
  const domains = {
    MAILEROO_DOMAIN: "maileroo-signed.example",
    GRAPH_DOMAIN: "graph-signed.example",
    /** Deliberately absent from the spec below: the off-allowlist case. */
    UNLISTED_DOMAIN: "unlisted.example",
    /**
     * THE ADDRESS-LEVEL CASE, and it has to sit on the MAILEROO-signed domain to
     * be worth anything. The rule this fixture exists to exercise is that an
     * address can out-rank its own domain: put this on graph-signed.example and
     * the test passes against an implementation with no address rule at all,
     * because the domain would have carried it to Graph anyway.
     *
     * Its neighbour on that domain is MAILEROO_FROM below, unlisted, which is
     * the other polarity: same domain, different transport, which is the whole
     * reason a domain key was not enough for the real deployment
     * (hfc.admin@yale.edu vs a personal yale.edu mailbox).
     */
    GRAPH_PINNED_FROM: "pinned@maileroo-signed.example",
  };
  process.env.SENDING_DOMAINS = `${domains.MAILEROO_DOMAIN}:maileroo,${domains.GRAPH_DOMAIN}:graph`;
  process.env.GRAPH_SENDER_ADDRESSES = domains.GRAPH_PINNED_FROM;
  return domains;
});

import {
  LogTransport,
  GraphTransport,
  MailerooTransport,
  SigningDomainRouter,
  TransientEmailError,
  resolveEmailTransport,
  type EmailMessage,
} from "./transport";
import { domainOf, GRAPH_SENDER_ADDRESSES } from "./sending-domains";
import { config } from "@/platform/config";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache, getSetting } from "@/platform/settings/service";
import { __resetTokenCache } from "./oauth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const msg: EmailMessage = {
  to: "volunteer@example.com",
  subject: "Test subject",
  html: "<p>Hello</p>",
};

/** A From the fixture allowlist says Maileroo can sign, so it sends AS itself. */
const MAILEROO_FROM = `campaigns@${MAILEROO_DOMAIN}`;
/** A From the fixture allowlist routes to Graph, so Maileroo must not sign it. */
const GRAPH_FROM = `dean@${GRAPH_DOMAIN}`;
/** A From on a domain the fixture allowlist does not carry at all. */
const UNLISTED_FROM = `someone@${UNLISTED_DOMAIN}`;
/**
 * What MailerooTransport falls back to when it may not send as the From. A real
 * deployment's pin is always on a Maileroo-signable domain, or every pinned send
 * would fail DMARC, so the fixture's pin is on one too.
 */
const PINNED_SENDER = `noreply@${MAILEROO_DOMAIN}`;
/**
 * A mailbox on the Maileroo-signed domain that is NOT in the fixture's Graph
 * address list. Graph-routed only when it is handed to the router as the
 * connected mailbox, which is the "no list entry needed" rule.
 */
const CONNECTED_MAILBOX = `mailbox@${MAILEROO_DOMAIN}`;

const fakeGetAccessToken = () => Promise.resolve("test-token");

/**
 * What the admin Failed card actually renders for a row: EmailLog.lastError cut
 * to 60 characters (src/app/(app)/admin/email/page.tsx). Everything past this is
 * tooltip-only, and log.error does not fire until all 8 attempts are spent, so a
 * diagnosis that does not fit here is a diagnosis the operator does not read.
 */
function failedCardText(err: unknown): string {
  return String(err instanceof Error ? err.message : err).slice(0, 60);
}

describe("LogTransport", () => {
  it("logs to console and resolves", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const transport = new LogTransport();
      await transport.send(msg);
      expect(spy).toHaveBeenCalledOnce();
      const [line] = spy.mock.calls[0];
      expect(line).toContain("volunteer@example.com");
      expect(line).toContain("Test subject");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("GraphTransport", () => {
  it("sends to the correct Graph URL with the encoded sender", async () => {
    const sender = "hfc.it@yale.edu";
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));

    const transport = new GraphTransport({
      getAccessToken: fakeGetAccessToken,
      sender,
      fetchImpl: fetchMock as typeof fetch,
    });
    await transport.send(msg);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain(encodeURIComponent(sender));
    expect(String(url)).toContain("sendMail");
  });

  it("sends POST with Authorization Bearer token and correct JSON body", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));

    const transport = new GraphTransport({
      getAccessToken: fakeGetAccessToken,
      sender: "hfc.it@yale.edu",
      fetchImpl: fetchMock as typeof fetch,
    });
    await transport.send(msg);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method?.toUpperCase()).toBe("POST");

    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-token");

    const parsed = JSON.parse(String(init.body));
    expect(parsed.message.subject).toBe(msg.subject);
    expect(parsed.message.body.contentType).toBe("HTML");
    expect(parsed.message.body.content).toBe(msg.html);
    expect(parsed.message.toRecipients[0].emailAddress.address).toBe(msg.to);
    expect(parsed.saveToSentItems).toBe(true);
  });

  it("throws with status and response text on non-2xx, without exposing the token", async () => {
    const fetchMock = vi.fn(
      async () => new Response("denied", { status: 403 })
    );

    const transport = new GraphTransport({
      getAccessToken: fakeGetAccessToken,
      sender: "hfc.it@yale.edu",
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(transport.send(msg)).rejects.toThrow(/403/);
    await expect(transport.send(msg)).rejects.toThrow(/denied/);
    // The token must not appear in the error message.
    try {
      await transport.send(msg);
    } catch (err) {
      expect(String(err)).not.toContain("test-token");
    }
  });

  it("rejects without calling fetch when getAccessToken throws", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));

    const transport = new GraphTransport({
      getAccessToken: () => Promise.reject(new Error("no credential")),
      sender: "hfc.it@yale.edu",
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(transport.send(msg)).rejects.toThrow("no credential");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends as message.from when provided, overriding the default sender", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
    const transport = new GraphTransport({
      getAccessToken: fakeGetAccessToken,
      sender: "hfc.it@yale.edu",
      fetchImpl: fetchMock as typeof fetch,
    });
    await transport.send({ ...msg, from: "recruit@yale.edu" });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain(encodeURIComponent("recruit@yale.edu"));
    expect(String(url)).not.toContain(encodeURIComponent("hfc.it@yale.edu"));
  });

  it("includes a from block with the display name when fromName is set", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
    const transport = new GraphTransport({
      getAccessToken: fakeGetAccessToken,
      sender: "hfc.it@yale.edu",
      fetchImpl: fetchMock as typeof fetch,
    });
    await transport.send({ ...msg, from: "recruit@yale.edu", fromName: "HAVEN Recruitment" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.message.from.emailAddress.address).toBe("recruit@yale.edu");
    expect(parsed.message.from.emailAddress.name).toBe("HAVEN Recruitment");
  });

  it("omits the from block when no fromName is given", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
    const transport = new GraphTransport({
      getAccessToken: fakeGetAccessToken,
      sender: "hfc.it@yale.edu",
      fetchImpl: fetchMock as typeof fetch,
    });
    await transport.send({ ...msg, from: "recruit@yale.edu" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.message.from).toBeUndefined();
  });

  it("inlines the layout <style> and drops the <style> block before delivery (Gmail clip fix)", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
    const transport = new GraphTransport({
      getAccessToken: fakeGetAccessToken,
      sender: "hfc.it@yale.edu",
      fetchImpl: fetchMock as typeof fetch,
    });
    const html =
      "<!DOCTYPE html><html><head><style>" +
      ".email-content a { color: #00356b; text-decoration: underline; }" +
      "</style></head><body><table><tr>" +
      '<td class="email-content"><p><a href="https://x">Open</a></p></td>' +
      "</tr></table></body></html>";
    await transport.send({ ...msg, html });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)).message.body.content as string;
    // The <style> block that triggers Gmail's "[Message clipped]" is gone...
    expect(sent).not.toMatch(/<style[\s>]/i);
    // ...and its rule is inlined onto the <a>, so the rendered look is preserved.
    expect(sent).toMatch(/<a\b[^>]*style="[^"]*color:\s*#00356b/i);
  });

  // #73: a temporary upstream failure must be TransientEmailError (retried) rather
  // than a plain Error (which burns the row's permanent attempt budget and would
  // mass-FAIL the queue's throttled tail on a Graph blip).
  const graph = (opts: { fetchImpl?: typeof fetch; getAccessToken?: () => Promise<string> }) =>
    new GraphTransport({
      getAccessToken: opts.getAccessToken ?? fakeGetAccessToken,
      sender: "hfc.it@yale.edu",
      fetchImpl: (opts.fetchImpl ?? (async () => new Response("", { status: 202 }))) as typeof fetch,
    });

  it.each([429, 500, 502, 503, 504])("classifies sendMail HTTP %s as transient", async (status) => {
    const t = graph({ fetchImpl: (async () => new Response("upstream", { status })) as typeof fetch });
    await expect(t.send(msg)).rejects.toBeInstanceOf(TransientEmailError);
  });

  it.each([400, 401, 403, 404])("keeps sendMail HTTP %s permanent (plain Error)", async (status) => {
    const t = graph({ fetchImpl: (async () => new Response("bad", { status })) as typeof fetch });
    const err = await t.send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransientEmailError);
  });

  it("classifies a sendMail request timeout as transient", async () => {
    const timeout = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    const t = graph({ fetchImpl: (async () => { throw timeout; }) as typeof fetch });
    await expect(t.send(msg)).rejects.toBeInstanceOf(TransientEmailError);
  });

  it("classifies a sendMail network failure as transient", async () => {
    const netErr = new TypeError("fetch failed");
    const t = graph({ fetchImpl: (async () => { throw netErr; }) as typeof fetch });
    await expect(t.send(msg)).rejects.toBeInstanceOf(TransientEmailError);
  });

  it("classifies a 5xx from the token endpoint as transient", async () => {
    const t = graph({ getAccessToken: () => Promise.reject(new Error("OAuth refresh failed with status 503: down")) });
    await expect(t.send(msg)).rejects.toBeInstanceOf(TransientEmailError);
  });

  it("keeps MailNotConnectedError permanent", async () => {
    const notConnected = Object.assign(new Error("Mailer is not connected"), { name: "MailNotConnectedError" });
    const t = graph({ getAccessToken: () => Promise.reject(notConnected) });
    const err = await t.send(msg).catch((e) => e);
    expect(err).not.toBeInstanceOf(TransientEmailError);
  });

  // ---- Send-As refusals -------------------------------------------------
  //
  // The owner accepted that routing a domain to Graph fails for any address the
  // connected mailbox has no Send-As grant on. Legibility was the mitigation, and
  // it survives the flip that took the last domain off Graph: this is what the
  // reversal lever lands an operator in. Raw, Graph says only:
  //   Graph sendMail failed: 403 {"error":{"code":"ErrorAccessDenied", ...}}
  // which names neither the address it tried, nor Send-As, nor any remedy -- and
  // the admin card shows only the first 60 characters of it.
  const DENIED_403 = JSON.stringify({
    error: { code: "ErrorAccessDenied", message: "Access is denied. Check credentials and try again." },
  });

  const denying = (body = DENIED_403, status = 403) =>
    graph({ fetchImpl: (async () => new Response(body, { status })) as typeof fetch });

  it("restates a Send-As refusal, naming the address and the grant needed", async () => {
    const err = await denying().send({ ...msg, from: "recruit@yale.edu" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransientEmailError);
    expect(err.message).toContain("recruit@yale.edu");
    expect(err.message).toMatch(/Send-As/);
    // The raw Graph code is kept, just demoted behind the remedy.
    expect(err.message).toContain("ErrorAccessDenied");
  });

  it("puts the Send-As remedy in the first 60 characters the admin card shows", async () => {
    const shown = failedCardText(
      await denying().send({ ...msg, from: "recruit@yale.edu" }).catch((e) => e)
    );
    expect(shown).toMatch(/Send-As/);
    expect(shown).toContain("recruit@yale.edu");
  });

  it("names the mailbox itself when the message carries no per-message from", async () => {
    const err = await denying().send(msg).catch((e) => e);
    expect(err.message).toContain("hfc.it@yale.edu");
  });

  it("leaves an unrelated 403 alone rather than guessing Send-As", async () => {
    const body = JSON.stringify({ error: { code: "ErrorQuotaExceeded", message: "Mailbox full." } });
    const err = await denying(body).send(msg).catch((e) => e);
    expect(err.message).toContain("Graph sendMail failed: 403");
    expect(err.message).not.toMatch(/Send-As/);
  });

  it("does not mistake a 401 for a Send-As problem", async () => {
    const err = await denying(DENIED_403, 401).send(msg).catch((e) => e);
    expect(err.message).not.toMatch(/Send-As/);
  });

  // ---- The 404, which is a DIFFERENT failure with a different remedy -------
  //
  // The owner hit this testing their own Yale address. Raw it is:
  //
  //   404 {"error":{"code":"MailboxNotEnabledForRESTAPI","message":"The mailbox
  //   is either inactive, soft-deleted, or is hosted on-premise."}}
  //
  // Three unrelated causes, no address, no remedy, and the true one (on-premise)
  // reads as the least likely of the three. Address-level routing makes this MORE
  // likely, not less: naming a mailbox in GRAPH_SENDER_ADDRESSES asserts Graph can
  // act on it, and this is exactly what a wrong assertion looks like.
  const NOT_IN_TENANT_404 = JSON.stringify({
    error: {
      code: "MailboxNotEnabledForRESTAPI",
      message: "The mailbox is either inactive, soft-deleted, or is hosted on-premise.",
    },
  });

  it("restates a not-in-Exchange-Online 404, naming the address and the real cause", async () => {
    const err = await denying(NOT_IN_TENANT_404, 404)
      .send({ ...msg, from: "alice@yale.edu" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // Permanent: no amount of retrying moves a mailbox into the tenant.
    expect(err).not.toBeInstanceOf(TransientEmailError);
    expect(err.message).toContain("alice@yale.edu");
    expect(err.message).toMatch(/not in Exchange Online/i);
    // Both levers that could have put it on Graph, since this layer cannot tell
    // which one matched.
    expect(err.message).toContain("GRAPH_SENDER_ADDRESSES");
    expect(err.message).toContain("SENDING_DOMAINS");
    // The raw Graph code is kept, demoted behind the remedy.
    expect(err.message).toContain("MailboxNotEnabledForRESTAPI");
  });

  it("puts the 404 remedy in the first 60 characters the admin card shows", async () => {
    const shown = failedCardText(
      await denying(NOT_IN_TENANT_404, 404)
        .send({ ...msg, from: "alice@yale.edu" })
        .catch((e) => e)
    );
    // Remedy first, like every other diagnosis here: the card truncates at 60
    // and log.error does not fire until all 8 attempts are spent.
    expect(shown).toContain("alice@yale.edu");
    expect(shown).toMatch(/Maileroo/);
  });

  it("does not give the 404 diagnosis to a 403, which needs the Send-As one", async () => {
    // The other polarity, and the one that keeps the two diagnoses distinct: a
    // single test on the 404 alone would pass against an implementation that
    // answered "route it to Maileroo" for every Graph failure, including the
    // Send-As refusal a grant actually fixes.
    const err = await denying().send({ ...msg, from: "recruit@yale.edu" }).catch((e) => e);
    expect(err.message).toMatch(/Send-As/);
    expect(err.message).not.toMatch(/not in Exchange Online/i);
  });

  it("leaves an unrelated 404 alone rather than guessing the mailbox is off-tenant", async () => {
    const body = JSON.stringify({ error: { code: "ResourceNotFound", message: "Not found." } });
    const err = await denying(body, 404).send(msg).catch((e) => e);
    expect(err.message).toContain("Graph sendMail failed: 404");
    expect(err.message).not.toMatch(/not in Exchange Online/i);
  });

  it("does not mistake a 400 carrying that code for the 404 case", async () => {
    const err = await denying(NOT_IN_TENANT_404, 400).send(msg).catch((e) => e);
    expect(err.message).toContain("Graph sendMail failed: 400");
    expect(err.message).not.toMatch(/not in Exchange Online/i);
  });
});

// ---------------------------------------------------------------------------
// MailerooTransport
// ---------------------------------------------------------------------------

describe("MailerooTransport", () => {
  /** Maileroo answers 200 with a { success, message, data } envelope. */
  const ok = () =>
    new Response(JSON.stringify({ success: true, message: "queued", data: { reference_id: "abc" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const maileroo = (fetchImpl?: typeof fetch) =>
    new MailerooTransport({
      apiKey: "test-key",
      sender: PINNED_SENDER,
      fetchImpl: (fetchImpl ?? (async () => ok())) as typeof fetch,
    });

  it("POSTs to the v2 send endpoint with the X-API-Key header and a v2 JSON body", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send(msg);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://smtp.maileroo.com/api/v2/emails");
    expect(init.method?.toUpperCase()).toBe("POST");

    const headers = new Headers(init.headers);
    expect(headers.get("X-API-Key")).toBe("test-key");
    expect(headers.get("Content-Type")).toBe("application/json");

    const parsed = JSON.parse(String(init.body));
    expect(parsed.from.address).toBe(PINNED_SENDER);
    expect(parsed.to).toEqual([{ address: msg.to }]);
    expect(parsed.subject).toBe(msg.subject);
    expect(parsed.html).toBe(msg.html);
  });

  it("never puts the API key in the request body", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send(msg);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).not.toContain("test-key");
  });

  // ---- The allowlist, at both polarities --------------------------------
  //
  // These two tests are a pair on purpose. Either one alone would pass against
  // an implementation that did only that one thing: the off-list case alone
  // passes against the old unconditional pin, and the on-list case alone passes
  // against a transport that blindly honors every `from`.

  // OFF-LIST. The allowlist gives this domain to a DIFFERENT transport, so
  // Maileroo holds no key for it. Honoring a per-template sender rule pointing
  // at one would put a Maileroo signature on a domain Maileroo cannot sign and
  // fail the send permanently.
  it("pins the sender when the From is on a domain Maileroo cannot sign", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send({ ...msg, from: GRAPH_FROM });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    // The address Maileroo cannot sign must never be the signed From...
    expect(parsed.from.address).toBe(PINNED_SENDER);
    // ...but it is preserved as Reply-To so replies still reach a human.
    expect(parsed.reply_to.address).toBe(GRAPH_FROM);
  });

  // ON-LIST. The allowlist says Maileroo signs this domain, so the address is
  // deliverable as itself and pinning it would be a downgrade with no upside:
  // the sender the admin configured never appears on the message.
  it("sends AS the From when it is on a Maileroo-signable domain", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send({
      ...msg,
      from: MAILEROO_FROM,
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.from.address).toBe(MAILEROO_FROM);
    // No Reply-To: the address the sender rule intended IS the signed From, so
    // there is nothing to preserve.
    expect(parsed.reply_to).toBeUndefined();
  });

  // A domain on neither side of the allowlist keeps the fallback behaviour
  // exactly, which is what makes the allowlist safe to narrow.
  it("pins the sender when the From is on a domain the allowlist does not carry", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send({ ...msg, from: UNLISTED_FROM });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.from.address).toBe(PINNED_SENDER);
    expect(parsed.reply_to.address).toBe(UNLISTED_FROM);
  });

  it("keeps the display name on a send that leaves as its own From", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send({
      ...msg,
      from: MAILEROO_FROM,
      fromName: "HAVEN Recruitment",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.from).toEqual({
      address: MAILEROO_FROM,
      display_name: "HAVEN Recruitment",
    });
  });

  // A row queued before the transport switch carries whatever address the sender
  // rule named at enqueue, snapshotted onto EmailLog.fromEmail. When the
  // allowlist since stopped giving that domain to Maileroo, the pin has to rescue
  // the backlog rather than fail it. Distinct from the OFF-LIST case above in
  // what it asserts: the display name survives a pin, and the whole Reply-To
  // object is carried over rather than just its address.
  it("pins the sender for a backlog row whose snapshotted sender Maileroo cannot sign", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send({
      ...msg,
      from: GRAPH_FROM,
      fromName: "HAVEN IT",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.from.address).toBe(PINNED_SENDER);
    // The display name is cosmetic and plays no part in DKIM alignment, so it survives.
    expect(parsed.from.display_name).toBe("HAVEN IT");
    expect(parsed.reply_to).toEqual({ address: GRAPH_FROM, display_name: "HAVEN IT" });
  });

  it("omits reply_to when the message carries no per-template sender", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send(msg);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).reply_to).toBeUndefined();
  });

  // Still reachable after the allowlist, via a transport whose own sender sits on
  // a domain Maileroo cannot sign (a leftover from the graph era): every send is
  // pinned, including one whose From already names that same address. The From is
  // given in a different case to prove the redundancy check is the same
  // case-insensitive comparison the pin uses, not string equality.
  it("omits a redundant reply_to when the intended sender is already the pinned one", async () => {
    const fetchMock = vi.fn(async () => ok());
    const pinnedToAnUnsignableAddress = new MailerooTransport({
      apiKey: "test-key",
      sender: GRAPH_FROM,
      fetchImpl: fetchMock as typeof fetch,
    });
    await pinnedToAnUnsignableAddress.send({ ...msg, from: `  ${GRAPH_FROM.toUpperCase()}  ` });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.from.address).toBe(GRAPH_FROM);
    expect(parsed.reply_to).toBeUndefined();
  });

  it("trims a signable From before sending as it", async () => {
    const fetchMock = vi.fn(async () => ok());
    // Upper-cased as well as padded: the allowlist lookup has to be
    // case-insensitive to recognise it, and the address still has to reach
    // Maileroo in the casing the sender rule wrote.
    await maileroo(fetchMock as typeof fetch).send({
      ...msg,
      from: `  ${MAILEROO_FROM.toUpperCase()}  `,
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.from.address).toBe(MAILEROO_FROM.toUpperCase());
    expect(parsed.reply_to).toBeUndefined();
  });

  it("sets display_name when fromName is given and omits it otherwise", async () => {
    const withName = vi.fn(async () => ok());
    await maileroo(withName as typeof fetch).send({ ...msg, fromName: "HAVEN Recruitment" });
    const [, a] = withName.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(a.body)).from.display_name).toBe("HAVEN Recruitment");

    const without = vi.fn(async () => ok());
    await maileroo(without as typeof fetch).send(msg);
    const [, b] = without.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(b.body)).from.display_name).toBeUndefined();
  });

  it("inlines the layout <style> and drops the <style> block before delivery (Gmail clip fix)", async () => {
    const fetchMock = vi.fn(async () => ok());
    const html =
      "<!DOCTYPE html><html><head><style>" +
      ".email-content a { color: #00356b; text-decoration: underline; }" +
      "</style></head><body><table><tr>" +
      '<td class="email-content"><p><a href="https://x">Open</a></p></td>' +
      "</tr></table></body></html>";
    await maileroo(fetchMock as typeof fetch).send({ ...msg, html });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)).html as string;
    expect(sent).not.toMatch(/<style[\s>]/i);
    expect(sent).toMatch(/<a\b[^>]*style="[^"]*color:\s*#00356b/i);
  });

  // A 200 carrying success:false is the dangerous case: without the envelope
  // check the drain stamps the row SENT and never retries, so the message is
  // silently never delivered.
  it("treats HTTP 200 with success:false as a permanent failure, not delivery", async () => {
    const body = JSON.stringify({ success: false, message: "Sending domain not verified" });
    const t = maileroo((async () =>
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch);
    const err = await t.send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransientEmailError);
    expect(String(err)).toContain("Sending domain not verified");
  });

  it("fails rather than assuming delivery when a 200 body is unparseable", async () => {
    const t = maileroo((async () => new Response("<html>gateway</html>", { status: 200 })) as typeof fetch);
    await expect(t.send(msg)).rejects.toThrow(/unparseable/);
  });

  it.each([429, 500, 502, 503, 504])("classifies HTTP %s as transient", async (status) => {
    const t = maileroo((async () => new Response("upstream", { status })) as typeof fetch);
    await expect(t.send(msg)).rejects.toBeInstanceOf(TransientEmailError);
  });

  it.each([400, 401, 403, 404, 422])("keeps HTTP %s permanent (plain Error)", async (status) => {
    const t = maileroo((async () => new Response("bad", { status })) as typeof fetch);
    const err = await t.send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransientEmailError);
  });

  it("classifies a request timeout as transient", async () => {
    const timeout = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    const t = maileroo((async () => { throw timeout; }) as typeof fetch);
    await expect(t.send(msg)).rejects.toBeInstanceOf(TransientEmailError);
  });

  it("classifies a network failure as transient", async () => {
    const t = maileroo((async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
    await expect(t.send(msg)).rejects.toBeInstanceOf(TransientEmailError);
  });

  it("does not leak the API key into a failure message", async () => {
    const t = maileroo((async () => new Response("denied", { status: 401 })) as typeof fetch);
    const err = await t.send(msg).catch((e) => e);
    expect(String(err)).not.toContain("test-key");
  });

  // ---- Domain-level rejections ------------------------------------------
  //
  // Both are CONFIGURATION states, not blips: no amount of retrying re-enables a
  // domain in the Maileroo dashboard or re-scopes a sending key. A transient
  // classification would spend the queue's whole back-off on something that
  // cannot succeed, so both must stay permanent -- and the two must stay
  // distinguishable, because they call for opposite fixes.
  const DISABLED_400 =
    "The domain 'yale.edu' is currently disabled. Please check your dashboard for more details.";
  const UNASSOCIATED_400 =
    "The domain 'example.com' is not associated with this sending key.";

  /**
   * A non-2xx from Maileroo, on the REAL wire shape: Maileroo answers JSON, and
   * the !res.ok branch runs the recogniser on res.text(), which is still
   * JSON-ESCAPED. A bare-string body would let a double-quoted domain match here
   * that cannot match in production, so this fixture asserts a payload that
   * actually occurs. See rejectingRaw for the plain-text case.
   */
  const rejecting = (message: string, status = 400) =>
    maileroo((async () =>
      new Response(JSON.stringify({ success: false, message }), {
        status,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch);

  /** A non-2xx whose body is not JSON at all (a gateway page, a bare string). */
  const rejectingRaw = (text: string, status = 400) =>
    maileroo((async () => new Response(text, { status })) as typeof fetch);

  it("classifies the domain-disabled rejection as PERMANENT", async () => {
    const err = await rejecting(DISABLED_400).send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransientEmailError);
  });

  it("classifies the not-associated-with-this-sending-key rejection as PERMANENT", async () => {
    const err = await rejecting(UNASSOCIATED_400).send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransientEmailError);
  });

  // Classified off the error TEXT, not the status, so the verdict survives
  // Maileroo ever answering the same configuration state with a retryable code.
  it("keeps the domain-disabled rejection permanent even on a status that is otherwise transient", async () => {
    for (const status of [429, 503]) {
      const err = await rejecting(DISABLED_400, status).send(msg).catch((e) => e);
      expect(err, `status ${status}`).not.toBeInstanceOf(TransientEmailError);
    }
  });

  // Asserted against the RESTATED diagnosis, not against words that survive in
  // Maileroo's raw text. Both raw messages already name their domain and one of
  // them already says "dashboard", so a looser assertion here would pass with the
  // recognition deleted entirely and prove nothing.
  it("distinguishes the two domain rejections in the surfaced message", async () => {
    const disabled = String(await rejecting(DISABLED_400).send(msg).catch((e) => e));
    const unassociated = String(await rejecting(UNASSOCIATED_400).send(msg).catch((e) => e));

    // The disabled case: the domain IS this sending key's, and the fix is in the
    // Maileroo dashboard.
    expect(disabled).toContain("Re-enable 'yale.edu' in the Maileroo dashboard");
    expect(disabled).toContain("SENDING_DOMAINS");
    // The not-associated case is the opposite diagnosis: the key belongs to a
    // different domain. Sending an operator to the dashboard here would point
    // them at a domain entry that is fine.
    expect(unassociated).toContain("Use a MAILEROO_API_KEY scoped to 'example.com'");
    expect(unassociated).toContain("domain-scoped");
    expect(unassociated).not.toMatch(/Re-enable/);
    expect(unassociated).not.toMatch(/dashboard/i);

    expect(disabled).not.toBe(unassociated);
  });

  // The admin Failed card truncates EmailLog.lastError to 60 characters
  // (admin/email/page.tsx), and the loud log.error only fires after all 8
  // attempts, so those 60 characters are the operator's whole diagnosis for a
  // long time. A leading "Maileroo send failed: 400 " status line spent 26 of
  // them saying nothing actionable.
  it("puts the fix in the first 60 characters, which is all the admin card shows", async () => {
    const disabled = failedCardText(await rejecting(DISABLED_400).send(msg).catch((e) => e));
    expect(disabled).toContain("Re-enable");
    expect(disabled).toContain("yale.edu");

    const unassociated = failedCardText(
      await rejecting(UNASSOCIATED_400).send(msg).catch((e) => e)
    );
    expect(unassociated).toContain("MAILEROO_API_KEY");
  });

  // Maileroo's wording is not a contract. The recognition's whole added value
  // over the generic 4xx rule is surviving a status change, and an exact-phrase
  // match would survive only "the status changed but the sentence stayed
  // byte-identical", which is the least likely pairing. Each variant is asserted
  // at 503, where an unrecognised text WOULD be classified transient and burn the
  // queue's back-off -- the precise failure this exists to prevent.
  it.each([
    ["has been disabled", "The domain 'yale.edu' has been disabled."],
    ["is disabled", "The domain 'yale.edu' is disabled."],
    ["is now disabled", "The domain 'yale.edu' is now disabled."],
    ["an unquoted domain", "The domain yale.edu is currently disabled."],
    ["a backtick-quoted domain", "The domain `yale.edu` is currently disabled."],
    ['a double-quoted domain', 'The domain "yale.edu" is currently disabled.'],
  ])("recognises the disabled rejection phrased as %s, even at 503", async (_label, text) => {
    const err = await rejecting(text, 503).send(msg).catch((e) => e);
    expect(err).not.toBeInstanceOf(TransientEmailError);
    expect(String(err)).toContain("Re-enable 'yale.edu' in the Maileroo dashboard");
  });

  it.each([
    ["associated with", "The domain 'example.com' is not associated with this sending key."],
    ["linked to", "The domain 'example.com' is not linked to this sending key."],
    ["linked with", "The domain example.com is not linked with this sending key."],
  ])("recognises the wrong-key rejection phrased as %s, even at 503", async (_label, text) => {
    const err = await rejecting(text, 503).send(msg).catch((e) => e);
    expect(err).not.toBeInstanceOf(TransientEmailError);
    expect(String(err)).toContain("Use a MAILEROO_API_KEY scoped to 'example.com'");
  });

  // The widening must not swallow an unrelated 5xx: those really are transient.
  it("still classifies an ordinary 503 as transient", async () => {
    await expect(rejecting("upstream unavailable", 503).send(msg)).rejects.toBeInstanceOf(
      TransientEmailError
    );
    await expect(rejectingRaw("upstream unavailable", 503).send(msg)).rejects.toBeInstanceOf(
      TransientEmailError
    );
  });

  // The recogniser exists so the diagnosis does not depend on which shape the API
  // used. That is only true if it survives JSON ESCAPING: the !res.ok branch runs
  // on res.text(), where a double-quoted domain arrives as \"yale.edu\", while
  // the 200/success:false branch runs on the already-parsed body.message. One
  // payload, two code paths, one answer.
  it("gives the same diagnosis for one payload on both the non-2xx and the 200 path", async () => {
    const message = 'The domain "yale.edu" is currently disabled.';
    const body = JSON.stringify({ success: false, message });

    const viaNonOk = await rejecting(message, 400).send(msg).catch((e) => e);
    const viaOkEnvelope = await maileroo((async () =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch)
      .send(msg)
      .catch((e) => e);

    for (const err of [viaNonOk, viaOkEnvelope]) {
      expect(err).not.toBeInstanceOf(TransientEmailError);
      expect(String(err)).toContain("Re-enable 'yale.edu' in the Maileroo dashboard");
    }
  });

  // The captured domain goes into the message an operator reads and may paste
  // back into SENDING_DOMAINS, so it must be the domain and nothing else. Letting
  // the escape into the character class matches, but captures "yale.edu\\".
  it("captures the domain without the JSON escape that quoted it", async () => {
    const err = await rejecting('The domain "yale.edu" is currently disabled.', 400)
      .send(msg)
      .catch((e) => e);
    expect(String(err)).toContain("'yale.edu'");
    expect(String(err)).not.toMatch(/yale\.edu\\/);
  });

  // Maileroo also spells rejections as a 200 carrying success:false, so the same
  // recognition has to apply on that path or the diagnosis depends on which
  // shape the API happened to use.
  it("recognises a domain rejection delivered as a 200 with success:false", async () => {
    const body = JSON.stringify({ success: false, message: DISABLED_400 });
    const t = maileroo((async () =>
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch);
    const err = await t.send(msg).catch((e) => e);
    expect(err).not.toBeInstanceOf(TransientEmailError);
    expect(String(err)).toContain("Re-enable 'yale.edu' in the Maileroo dashboard");
    // Same truncation rule applies on this path.
    expect(failedCardText(err)).toContain("Re-enable");
  });
});

// ---------------------------------------------------------------------------
// SigningDomainRouter
// ---------------------------------------------------------------------------

describe("SigningDomainRouter", () => {
  /** A transport that records the messages handed to it and does nothing else. */
  const spyTransport = () => {
    const sent: EmailMessage[] = [];
    return { sent, send: async (m: EmailMessage) => void sent.push(m) };
  };

  const build = (graphMailbox?: string | null) => {
    const mailerooStub = spyTransport();
    const graphStub = spyTransport();
    const fallback = spyTransport();
    const router = new SigningDomainRouter({
      fallback,
      signers: { maileroo: mailerooStub, graph: graphStub },
      graphMailbox,
    });
    return { router, mailerooStub, graphStub, fallback };
  };

  // The pair, at both polarities. Either one alone passes against a router that
  // sends everything to that one transport, so neither is worth much without the
  // other. The Graph half is the one nothing in the shipped default reaches
  // today, which is exactly why it is driven from the fixture allowlist.
  it("routes a From on a Graph-signable domain to Graph", async () => {
    const { router, mailerooStub, graphStub, fallback } = build();
    await router.send({ ...msg, from: GRAPH_FROM });
    expect(graphStub.sent).toHaveLength(1);
    expect(mailerooStub.sent).toHaveLength(0);
    expect(fallback.sent).toHaveLength(0);
  });

  it("routes a From on a Maileroo-signable domain to Maileroo", async () => {
    const { router, mailerooStub, graphStub, fallback } = build();
    await router.send({ ...msg, from: MAILEROO_FROM });
    expect(mailerooStub.sent).toHaveLength(1);
    expect(graphStub.sent).toHaveLength(0);
    expect(fallback.sent).toHaveLength(0);
  });

  // ---- ADDRESS BEFORE DOMAIN ---------------------------------------------
  //
  // THE PAIR THAT MATTERS, and it is a pair on purpose. Both of these addresses
  // sit on maileroo-signed.example. If only the first were asserted it would
  // pass against a router that sent everything to Graph; if only the second, one
  // that ignored the address list entirely. Together they are the claim: on ONE
  // domain, two addresses, two transports -- which is the thing a domain-keyed
  // router could not express and the reason this rule exists
  // (hfc.admin@yale.edu is a tenant mailbox Graph can send as, alice@yale.edu is
  // an on-premise one it cannot).
  it("routes a GRAPH_SENDER_ADDRESSES address to Graph even though its domain is Maileroo-signed", async () => {
    const { router, mailerooStub, graphStub, fallback } = build();
    await router.send({ ...msg, from: GRAPH_PINNED_FROM });
    expect(graphStub.sent).toHaveLength(1);
    expect(mailerooStub.sent).toHaveLength(0);
    expect(fallback.sent).toHaveLength(0);
  });

  it("routes an UNLISTED address on that same Maileroo-signed domain to Maileroo", async () => {
    const { router, mailerooStub, graphStub, fallback } = build();
    // Same domain as GRAPH_PINNED_FROM above, deliberately.
    expect(domainOf(MAILEROO_FROM)).toBe(domainOf(GRAPH_PINNED_FROM));
    await router.send({ ...msg, from: MAILEROO_FROM });
    expect(mailerooStub.sent).toHaveLength(1);
    expect(graphStub.sent).toHaveLength(0);
    expect(fallback.sent).toHaveLength(0);
  });

  it("matches an address case- and whitespace-blind, since a sender rule is typed by hand", async () => {
    const { router, graphStub } = build();
    await router.send({ ...msg, from: `  ${GRAPH_PINNED_FROM.toUpperCase()}  ` });
    expect(graphStub.sent).toHaveLength(1);
  });

  // ---- The connected mailbox, with no list entry --------------------------
  it("routes the connected Graph mailbox to Graph without a list entry", async () => {
    const { router, mailerooStub, graphStub } = build(CONNECTED_MAILBOX);
    // It really is absent from the fixture's address list: the pass below is the
    // mailbox rule firing, not the address rule.
    expect(GRAPH_SENDER_ADDRESSES.has(CONNECTED_MAILBOX)).toBe(false);
    await router.send({ ...msg, from: CONNECTED_MAILBOX });
    expect(graphStub.sent).toHaveLength(1);
    expect(mailerooStub.sent).toHaveLength(0);
  });

  it("sends that same address to Maileroo when it is NOT the connected mailbox", async () => {
    // The other polarity. Without it the test above passes against a router that
    // hard-codes this address, or one that sends the whole domain to Graph.
    const { router, mailerooStub, graphStub } = build(null);
    await router.send({ ...msg, from: CONNECTED_MAILBOX });
    expect(mailerooStub.sent).toHaveLength(1);
    expect(graphStub.sent).toHaveLength(0);
  });

  it("sends a message with no From to the fallback", async () => {
    const { router, graphStub, fallback } = build();
    await router.send(msg);
    expect(fallback.sent).toHaveLength(1);
    expect(graphStub.sent).toHaveLength(0);
  });

  it("sends a From on an unlisted domain to the fallback", async () => {
    const { router, graphStub, fallback } = build();
    await router.send({ ...msg, from: UNLISTED_FROM });
    expect(fallback.sent).toHaveLength(1);
    expect(graphStub.sent).toHaveLength(0);
  });

  it("hands the message through untouched, so the chosen transport still decides the From", async () => {
    const { router, graphStub } = build();
    await router.send({ ...msg, from: GRAPH_FROM, fromName: "HAVEN IT" });
    expect(graphStub.sent[0].from).toBe(GRAPH_FROM);
    expect(graphStub.sent[0].fromName).toBe("HAVEN IT");
  });

  // The router owns routing and nothing else. Swallowing or re-wrapping an error
  // here would break the queue's transient/permanent split, which reads the
  // error's own type (see drainEmailQueue).
  it("propagates the chosen transport's error unchanged, transient class included", async () => {
    const boom = new TransientEmailError("throttled");
    const router = new SigningDomainRouter({
      fallback: { send: async () => { throw new Error("wrong transport"); } },
      signers: { graph: { send: async () => { throw boom; } } },
    });
    await expect(router.send({ ...msg, from: GRAPH_FROM })).rejects.toBe(boom);
    // A transient failure is going to be retried, so routing advice on it is
    // noise. The message must be untouched as well as the type.
    expect(boom.message).toBe("throttled");
  });

  // ---- Why was this message even on that transport? ----------------------
  //
  // The routing decision is the router's own knowledge and nowhere else's. A
  // Graph failure inside a Maileroo deployment otherwise reads as a broken Graph
  // mailbox rather than as a From-domain routing consequence, which is the wrong
  // thing to go and fix.
  it("says which allowlist row put a failing message on that transport", async () => {
    const boom = new Error(`Grant Send-As on ${GRAPH_FROM} ...`);
    const router = new SigningDomainRouter({
      fallback: { send: async () => { throw new Error("wrong transport"); } },
      signers: { graph: { send: async () => { throw boom; } } },
    });
    const err = await router.send({ ...msg, from: GRAPH_FROM }).catch((e) => e);
    // Same object: the queue reads the error's type and name, so re-wrapping it
    // in a fresh Error would silently re-classify the failure.
    expect(err).toBe(boom);
    expect(err.message).toContain("SENDING_DOMAINS");
    // The whole allowlist row, not just the domain: an operator who is told only
    // which domain is involved has not been told what it was routed to, which is
    // the fact that explains why a Graph mailbox failed a Maileroo deployment.
    expect(err.message).toContain(`lists ${GRAPH_DOMAIN} as graph-signed`);
    // The remedy the transport wrote still comes first, for the 60-char card.
    expect(failedCardText(err)).toContain("Grant Send-As");
  });

  // The note has to name the lever that ACTUALLY routed the message. Before the
  // address rule it said "SENDING_DOMAINS lists <domain> ..." unconditionally,
  // which for an address-routed message sends the operator to a variable that
  // says nothing about their address.
  it("names GRAPH_SENDER_ADDRESSES, not SENDING_DOMAINS, when the ADDRESS did the routing", async () => {
    const boom = new Error(`Route ${GRAPH_PINNED_FROM} to Maileroo instead ...`);
    const router = new SigningDomainRouter({
      fallback: { send: async () => { throw new Error("wrong transport"); } },
      signers: { graph: { send: async () => { throw boom; } } },
    });
    const err = await router.send({ ...msg, from: GRAPH_PINNED_FROM }).catch((e) => e);
    expect(err).toBe(boom);
    expect(err.message).toContain(`GRAPH_SENDER_ADDRESSES names ${GRAPH_PINNED_FROM}`);
    expect(err.message).toContain(`Take ${GRAPH_PINNED_FROM} out of GRAPH_SENDER_ADDRESSES`);
    // And NOT the domain lever, which would be the wrong thing to go and edit:
    // maileroo-signed.example is on SENDING_DOMAINS as maileroo, so removing it
    // would not move this message off Graph.
    expect(err.message).not.toContain("SENDING_DOMAINS lists");
  });

  it("says it was the connected mailbox when that is what did the routing", async () => {
    const boom = new Error("graph exploded");
    const router = new SigningDomainRouter({
      fallback: { send: async () => { throw new Error("wrong transport"); } },
      signers: { graph: { send: async () => { throw boom; } } },
      graphMailbox: CONNECTED_MAILBOX,
    });
    const err = await router.send({ ...msg, from: CONNECTED_MAILBOX }).catch((e) => e);
    expect(err.message).toContain("IS the mailbox Graph is connected as");
    // Neither env lever is named, because editing either would change nothing.
    expect(err.message).not.toContain("GRAPH_SENDER_ADDRESSES names");
    expect(err.message).not.toContain("SENDING_DOMAINS lists");
  });

  it("adds no note when the message went to the fallback, since nothing surprising happened", async () => {
    const boom = new Error("plain failure");
    const router = new SigningDomainRouter({
      fallback: { send: async () => { throw boom; } },
      signers: {},
    });
    await expect(router.send({ ...msg, from: UNLISTED_FROM })).rejects.toBe(boom);
    expect(boom.message).toBe("plain failure");
  });

  it("adds no note when the signer chosen IS the fallback", async () => {
    // A Maileroo-signed domain routes to the maileroo slot, which in a Maileroo
    // deployment is the same object as the fallback. Nothing was rerouted.
    const boom = new Error("plain failure");
    const maileroo = { send: async () => { throw boom; } };
    const router = new SigningDomainRouter({ fallback: maileroo, signers: { maileroo } });
    await expect(router.send({ ...msg, from: MAILEROO_FROM })).rejects.toBe(boom);
    expect(boom.message).toBe("plain failure");
  });
});

// ---------------------------------------------------------------------------
// resolveEmailTransport (DB-backed factory)
// ---------------------------------------------------------------------------

describe("resolveEmailTransport", () => {
  beforeEach(async () => { await resetDb(); _resetSettingsCache(); });

  it("returns a LogTransport when email.transport is log (default)", async () => {
    const t = await resolveEmailTransport();
    expect(t).toBeInstanceOf(LogTransport);
  });

  it("returns a LogTransport when email.transport is overridden to log in the DB", async () => {
    await prisma.setting.create({ data: { key: "email.transport", value: "log" } });
    _resetSettingsCache();
    const t = await resolveEmailTransport();
    expect(t).toBeInstanceOf(LogTransport);
  });

  it("returns a GraphTransport when email.transport is overridden to graph in the DB", async () => {
    await prisma.setting.create({ data: { key: "email.transport", value: "graph" } });
    await prisma.setting.create({ data: { key: "email.sender", value: "noreply@example.com" } });
    _resetSettingsCache();
    const t = await resolveEmailTransport();
    expect(t).toBeInstanceOf(GraphTransport);
  });

  // WHAT MUST NOT CHANGE. Under "graph" everything goes through Graph and no
  // routing happens at all -- that is production's current state, and it is why
  // the whole allowlist has been inert and why flipping the setting is the
  // hazard routing-gap.ts exists for. The address rule must not have quietly
  // introduced routing on this branch: a bare GraphTransport, not a router.
  it("does NOT route by address under graph, whatever GRAPH_SENDER_ADDRESSES says", async () => {
    await prisma.setting.create({ data: { key: "email.transport", value: "graph" } });
    await prisma.setting.create({ data: { key: "email.sender", value: PINNED_SENDER } });
    _resetSettingsCache();
    const t = await resolveEmailTransport();
    expect(t).toBeInstanceOf(GraphTransport);
    expect(t).not.toBeInstanceOf(SigningDomainRouter);
    // The fixture list is non-empty, so this is a real assertion rather than a
    // vacuous one: under maileroo these same addresses DO route.
    expect(GRAPH_SENDER_ADDRESSES.size).toBeGreaterThan(0);
  });

  it("reads the current transport at drain time, ignoring a stale 'log' left in the cache (#76)", async () => {
    // The clinic is mid-switch to Graph: the row is now "graph" (+ sender), but
    // THIS instance's 30s settings cache still holds the pre-switch "log" because
    // setSetting only invalidated the writing instance's cache. A cached read here
    // would drain real mail through LogTransport and mark it SENT unrecoverably.
    await prisma.setting.create({ data: { key: "email.transport", value: "log" } });
    await prisma.setting.create({ data: { key: "email.sender", value: "noreply@example.com" } });
    _resetSettingsCache();
    // Warm this process's cache with the stale "log".
    expect(await getSetting("email.transport")).toBe("log");
    // Another instance completes the switch: the committed row is now "graph".
    await prisma.setting.update({ where: { key: "email.transport" }, data: { value: "graph" } });
    // (cache intentionally NOT reset -- getSetting("email.transport") still returns "log")

    // The drain must resolve the committed "graph", not the stale cached "log".
    const t = await resolveEmailTransport();
    expect(t).toBeInstanceOf(GraphTransport);
  });

  /** Set config.MAILEROO_API_KEY for one test and restore it afterwards. */
  async function withApiKey<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const mutable = config as { MAILEROO_API_KEY?: string };
    const previous = mutable.MAILEROO_API_KEY;
    mutable.MAILEROO_API_KEY = value;
    try {
      return await fn();
    } finally {
      mutable.MAILEROO_API_KEY = previous;
    }
  }

  it("returns a domain router over Maileroo when email.transport is maileroo and the key is set", async () => {
    await prisma.setting.create({ data: { key: "email.transport", value: "maileroo" } });
    await prisma.setting.create({ data: { key: "email.sender", value: PINNED_SENDER } });
    _resetSettingsCache();
    const t = await withApiKey("test-key", resolveEmailTransport);
    expect(t).toBeInstanceOf(SigningDomainRouter);
  });

  /** Set the Graph OAuth credentials for one test and restore them afterwards. */
  async function withGraphOAuth<T>(present: boolean, fn: () => Promise<T>): Promise<T> {
    const keys = [
      "GRAPH_OAUTH_TENANT_ID",
      "GRAPH_OAUTH_CLIENT_ID",
      "GRAPH_OAUTH_CLIENT_SECRET",
    ] as const;
    const mutable = config as unknown as Record<string, string | undefined>;
    const previous = keys.map((key) => mutable[key]);
    for (const key of keys) mutable[key] = present ? "configured" : "";
    try {
      return await fn();
    } finally {
      keys.forEach((key, i) => {
        mutable[key] = previous[i];
      });
    }
  }

  /** The singleton row that means "an admin has connected a Graph mailbox". */
  const connectGraphMailbox = () =>
    prisma.mailCredential.create({
      data: { id: "mailer", refreshToken: "rt", account: "hfc.it@yale.edu" },
    });

  // The router is only worth having if its slots are wired to the right
  // transports, and an instanceof check cannot see that. These send a real
  // message through the resolved transport and assert on which upstream it
  // reached, at both polarities.
  describe("wires the maileroo router to the transport that signs each domain", () => {
    beforeEach(async () => {
      await prisma.setting.create({ data: { key: "email.transport", value: "maileroo" } });
      await prisma.setting.create({
        data: { key: "email.sender", value: PINNED_SENDER },
      });
      _resetSettingsCache();
      __resetTokenCache();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      __resetTokenCache();
    });

    it("sends a Maileroo-signable From to the Maileroo API", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      vi.stubGlobal("fetch", fetchMock);
      await withApiKey("test-key", async () => {
        const t = await resolveEmailTransport();
        await t.send({ ...msg, from: MAILEROO_FROM });
      });
      const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain("smtp.maileroo.com");
    });

    it("sends a Graph-signable From to Graph, not Maileroo", async () => {
      await connectGraphMailbox();
      const fetchMock = vi.fn(async () => new Response("", { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);
      await withApiKey("test-key", () =>
        withGraphOAuth(true, async () => {
          const t = await resolveEmailTransport();
          // The Entra token POST is the assertion: only the Graph transport asks
          // for a delegated token, so reaching login.microsoftonline proves the
          // message was not handed to Maileroo.
          await t.send({ ...msg, from: GRAPH_FROM }).catch(() => undefined);
        })
      );
      const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain("login.microsoftonline.com");
    });

    // ---- The Graph signer's preconditions ------------------------------
    //
    // The maileroo branch refuses a missing MAILEROO_API_KEY or email.sender with
    // a named reason. Its Graph signer used to be wired with no guard at all, so
    // a deployment that chose Maileroo precisely to avoid Graph failed every
    // Graph-routed row with "Mail account is not connected", which reads as a
    // broken mailbox rather than as a routing decision. Blast radius includes the
    // auth sender category, i.e. magic-link login.

    it("refuses per message, routing-first, when no Graph mailbox is connected", async () => {
      // No MailCredential row: resetDb truncated it and this test creates none.
      const err = await withApiKey("test-key", () =>
        withGraphOAuth(true, async () => {
          const t = await resolveEmailTransport();
          return t.send({ ...msg, from: GRAPH_FROM }).catch((e) => e);
        })
      );
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TransientEmailError);
      // The first 60 characters must say this is a ROUTING decision with a
      // remedy, not that the mailbox is broken. It no longer names the lever
      // there, and cannot: two rules can put a From on Graph now, and this
      // signer is resolved once for all of them. Both are named in the body, and
      // the ROUTER appends the one that actually matched (see the annotation
      // tests above), which is strictly more than the old wording said.
      expect(failedCardText(err)).toContain("Stop routing this From to Graph");
      expect(failedCardText(err)).not.toMatch(/not connected/i);
      // Both levers in the body, since the signer cannot tell which applied.
      expect(err.message).toContain("SENDING_DOMAINS");
      expect(err.message).toContain("GRAPH_SENDER_ADDRESSES");
      // And the router names the row that put this message here specifically, so
      // the operator knows which domain to take off rather than which mailbox to
      // go and repair.
      expect(err.message).toContain(`lists ${GRAPH_DOMAIN} as graph-signed`);
    });

    it("refuses per message, naming the missing Graph credentials", async () => {
      await connectGraphMailbox();
      const err = await withApiKey("test-key", () =>
        withGraphOAuth(false, async () => {
          const t = await resolveEmailTransport();
          return t.send({ ...msg, from: GRAPH_FROM }).catch((e) => e);
        })
      );
      expect(err).not.toBeInstanceOf(TransientEmailError);
      expect(err.message).toContain("GRAPH_OAUTH_CLIENT_ID");
      // Routing-first in the 60 characters the card shows; see the sibling test
      // above for why the lever itself no longer fits there.
      expect(failedCardText(err)).toContain("Stop routing this From to Graph");
      expect(err.message).toContain("SENDING_DOMAINS");
    });

    // The project-wide rule is that reads DEGRADE rather than throw, which is why
    // the settings reads above catch P1001. A failed credential read must not be
    // read as "not connected": that would refuse every Graph-routed send for the
    // whole tick on the strength of one bad read.
    it("does not read a database failure as 'no mailbox connected'", async () => {
      const spy = vi
        .spyOn(prisma.mailCredential, "findUnique")
        .mockRejectedValue(new Error("P1001: Can't reach database server"));
      try {
        const err = await withApiKey("test-key", () =>
          withGraphOAuth(true, async () => {
            const t = await resolveEmailTransport();
            return t.send({ ...msg, from: GRAPH_FROM }).catch((e) => e);
          })
        );
        // A real GraphTransport was wired. The failure that surfaces is the one
        // the token path hit on the same unreachable database, NOT a refusal
        // telling an admin to go and connect a mailbox that is already connected.
        expect(String(err)).toContain("P1001");
        expect(String(err)).not.toContain("connect a mailbox in Admin");
      } finally {
        spy.mockRestore();
      }
    });

    it("leaves the Maileroo half working when the Graph signer is unusable", async () => {
      // The guard must refuse only the Graph-routed messages. A deployment with
      // no Graph mailbox still sends all of its havenfreeclinic.org mail.
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      vi.stubGlobal("fetch", fetchMock);
      await withApiKey("test-key", () =>
        withGraphOAuth(false, async () => {
          const t = await resolveEmailTransport();
          await t.send({ ...msg, from: MAILEROO_FROM });
          await t.send(msg);
        })
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("falls back to the log transport outside production when the Maileroo key is missing", async () => {
    await prisma.setting.create({ data: { key: "email.transport", value: "maileroo" } });
    await prisma.setting.create({ data: { key: "email.sender", value: PINNED_SENDER } });
    _resetSettingsCache();
    const t = await withApiKey(undefined, resolveEmailTransport);
    expect(t).toBeInstanceOf(LogTransport);
  });

  // The production counterpart of the test above: silently degrading to
  // LogTransport would let the drain stamp every row SENT while delivering
  // nothing, exactly as it would for a graph transport with no sender (#76).
  it("refuses PER MESSAGE in production when the Maileroo key is missing, so rows go FAILED", async () => {
    await prisma.setting.create({ data: { key: "email.transport", value: "maileroo" } });
    await prisma.setting.create({ data: { key: "email.sender", value: PINNED_SENDER } });
    _resetSettingsCache();
    vi.stubEnv("VERCEL_ENV", "production");
    try {
      await withApiKey(undefined, async () => {
        const t = await resolveEmailTransport();
        await expect(t.send({ to: "a@b.c", subject: "s", html: "<p>h</p>" })).rejects.toThrow(/MAILEROO_API_KEY/);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses per message in production when maileroo is selected with no sender address", async () => {
    await prisma.setting.create({ data: { key: "email.transport", value: "maileroo" } });
    _resetSettingsCache();
    vi.stubEnv("VERCEL_ENV", "production");
    try {
      await withApiKey("test-key", async () => {
        const t = await resolveEmailTransport();
        await expect(t.send({ to: "a@b.c", subject: "s", html: "<p>h</p>" })).rejects.toThrow(/email\.sender/);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
