import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  LogTransport,
  GraphTransport,
  MailerooTransport,
  SigningDomainRouter,
  TransientEmailError,
  resolveEmailTransport,
  type EmailMessage,
} from "./transport";
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

const fakeGetAccessToken = () => Promise.resolve("test-token");

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
      sender: "noreply@havenfreeclinic.org",
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
    expect(parsed.from.address).toBe("noreply@havenfreeclinic.org");
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

  // OFF-LIST. Maileroo cannot sign yale.edu (its entry there is registered but
  // disabled), so honoring a per-template @yale.edu sender rule would fail the
  // send permanently on an unsignable domain.
  it("pins the sender when the From is on a domain Maileroo cannot sign", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send({ ...msg, from: "recruit@yale.edu" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    // The unsignable @yale.edu address must never be the signed From...
    expect(parsed.from.address).toBe("noreply@havenfreeclinic.org");
    // ...but it is preserved as Reply-To so replies still reach a human.
    expect(parsed.reply_to.address).toBe("recruit@yale.edu");
  });

  // ON-LIST. havenfreeclinic.org publishes include:_spf.maileroo.com, so this
  // address is signable as itself and pinning it would be a downgrade with no
  // upside: the sender the admin configured never appears on the message.
  it("sends AS the From when it is on a Maileroo-signable domain", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send({
      ...msg,
      from: "recruitment@havenfreeclinic.org",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.from.address).toBe("recruitment@havenfreeclinic.org");
    // No Reply-To: the address the sender rule intended IS the signed From, so
    // there is nothing to preserve.
    expect(parsed.reply_to).toBeUndefined();
  });

  // A domain on neither side of the allowlist keeps the fallback behaviour
  // exactly, which is what makes the allowlist safe to narrow.
  it("pins the sender when the From is on a domain the allowlist does not carry", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send({ ...msg, from: "someone@example.com" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.from.address).toBe("noreply@havenfreeclinic.org");
    expect(parsed.reply_to.address).toBe("someone@example.com");
  });

  it("keeps the display name on a send that leaves as its own From", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send({
      ...msg,
      from: "recruitment@havenfreeclinic.org",
      fromName: "HAVEN Recruitment",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.from).toEqual({
      address: "recruitment@havenfreeclinic.org",
      display_name: "HAVEN Recruitment",
    });
  });

  // Rows queued before the transport switch already carry an @yale.edu address in
  // EmailLog.fromEmail; the pin has to rescue those too rather than fail the backlog.
  it("pins the sender for a backlog row whose @yale.edu sender was snapshotted at enqueue", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send({
      ...msg,
      from: "hfc.it@yale.edu",
      fromName: "HAVEN IT",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.from.address).toBe("noreply@havenfreeclinic.org");
    // The display name is cosmetic and plays no part in DKIM alignment, so it survives.
    expect(parsed.from.display_name).toBe("HAVEN IT");
    expect(parsed.reply_to).toEqual({ address: "hfc.it@yale.edu", display_name: "HAVEN IT" });
  });

  it("omits reply_to when the message carries no per-template sender", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send(msg);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).reply_to).toBeUndefined();
  });

  // Still reachable after the allowlist, via a transport whose own sender is on
  // an unsignable domain (a leftover from the graph era): every send is pinned,
  // including one whose From already names that same address.
  it("omits a redundant reply_to when the intended sender is already the pinned one", async () => {
    const fetchMock = vi.fn(async () => ok());
    const pinnedToYale = new MailerooTransport({
      apiKey: "test-key",
      sender: "hfc.it@yale.edu",
      fetchImpl: fetchMock as typeof fetch,
    });
    await pinnedToYale.send({ ...msg, from: "  HFC.IT@Yale.edu  " });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.from.address).toBe("hfc.it@yale.edu");
    expect(parsed.reply_to).toBeUndefined();
  });

  it("trims a signable From before sending as it", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send({
      ...msg,
      from: "  NoReply@HavenFreeClinic.org  ",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.from.address).toBe("NoReply@HavenFreeClinic.org");
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

  const rejecting = (text: string, status = 400) =>
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
    expect(disabled).toContain("sending domain 'yale.edu' is DISABLED in the Maileroo dashboard");
    expect(disabled).toContain("SENDING_DOMAINS");
    // The not-associated case is the opposite diagnosis: the key belongs to a
    // different domain. Sending an operator to the dashboard here would point
    // them at a domain entry that is fine.
    expect(unassociated).toContain(
      "'example.com' is not associated with this Maileroo sending key"
    );
    expect(unassociated).toContain("MAILEROO_API_KEY belongs to a different domain");
    expect(unassociated).not.toMatch(/is DISABLED/);

    expect(disabled).not.toBe(unassociated);
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
    expect(String(err)).toContain("is DISABLED in the Maileroo dashboard");
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

  const build = () => {
    const mailerooStub = spyTransport();
    const graphStub = spyTransport();
    const fallback = spyTransport();
    const router = new SigningDomainRouter({
      fallback,
      signers: { maileroo: mailerooStub, graph: graphStub },
    });
    return { router, mailerooStub, graphStub, fallback };
  };

  it("routes a From on a Graph-signable domain to Graph", async () => {
    const { router, mailerooStub, graphStub, fallback } = build();
    await router.send({ ...msg, from: "hfc.it@yale.edu" });
    expect(graphStub.sent).toHaveLength(1);
    expect(mailerooStub.sent).toHaveLength(0);
    expect(fallback.sent).toHaveLength(0);
  });

  it("routes a From on a Maileroo-signable domain to Maileroo", async () => {
    const { router, mailerooStub, graphStub, fallback } = build();
    await router.send({ ...msg, from: "recruitment@havenfreeclinic.org" });
    expect(mailerooStub.sent).toHaveLength(1);
    expect(graphStub.sent).toHaveLength(0);
    expect(fallback.sent).toHaveLength(0);
  });

  it("sends a message with no From to the fallback", async () => {
    const { router, graphStub, fallback } = build();
    await router.send(msg);
    expect(fallback.sent).toHaveLength(1);
    expect(graphStub.sent).toHaveLength(0);
  });

  it("sends a From on an unlisted domain to the fallback", async () => {
    const { router, graphStub, fallback } = build();
    await router.send({ ...msg, from: "someone@example.com" });
    expect(fallback.sent).toHaveLength(1);
    expect(graphStub.sent).toHaveLength(0);
  });

  it("hands the message through untouched, so the chosen transport still decides the From", async () => {
    const { router, graphStub } = build();
    await router.send({ ...msg, from: "hfc.it@yale.edu", fromName: "HAVEN IT" });
    expect(graphStub.sent[0].from).toBe("hfc.it@yale.edu");
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
    await expect(router.send({ ...msg, from: "hfc.it@yale.edu" })).rejects.toBe(boom);
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
    await prisma.setting.create({ data: { key: "email.sender", value: "noreply@havenfreeclinic.org" } });
    _resetSettingsCache();
    const t = await withApiKey("test-key", resolveEmailTransport);
    expect(t).toBeInstanceOf(SigningDomainRouter);
  });

  // The router is only worth having if its slots are wired to the right
  // transports, and an instanceof check cannot see that. These two send a real
  // message through the resolved transport and assert on which upstream it
  // reached, at both polarities.
  describe("wires the maileroo router to the transport that signs each domain", () => {
    beforeEach(async () => {
      await prisma.setting.create({ data: { key: "email.transport", value: "maileroo" } });
      await prisma.setting.create({
        data: { key: "email.sender", value: "noreply@havenfreeclinic.org" },
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
        await t.send({ ...msg, from: "recruitment@havenfreeclinic.org" });
      });
      const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain("smtp.maileroo.com");
    });

    it("sends a Graph-signable From to Graph, not Maileroo", async () => {
      const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
      vi.stubGlobal("fetch", fetchMock);
      await withApiKey("test-key", async () => {
        const t = await resolveEmailTransport();
        // No MailCredential row exists (resetDb truncated it), so the Graph path
        // fails at token acquisition. That failure IS the assertion: only the
        // Graph transport asks for a delegated token, so reaching it proves the
        // message was not handed to Maileroo, which would have answered 202.
        await expect(t.send({ ...msg, from: "hfc.it@yale.edu" })).rejects.toThrow(
          /not connected/i
        );
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("falls back to the log transport outside production when the Maileroo key is missing", async () => {
    await prisma.setting.create({ data: { key: "email.transport", value: "maileroo" } });
    await prisma.setting.create({ data: { key: "email.sender", value: "noreply@havenfreeclinic.org" } });
    _resetSettingsCache();
    const t = await withApiKey(undefined, resolveEmailTransport);
    expect(t).toBeInstanceOf(LogTransport);
  });

  // The production counterpart of the test above: silently degrading to
  // LogTransport would let the drain stamp every row SENT while delivering
  // nothing, exactly as it would for a graph transport with no sender (#76).
  it("refuses PER MESSAGE in production when the Maileroo key is missing, so rows go FAILED", async () => {
    await prisma.setting.create({ data: { key: "email.transport", value: "maileroo" } });
    await prisma.setting.create({ data: { key: "email.sender", value: "noreply@havenfreeclinic.org" } });
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
