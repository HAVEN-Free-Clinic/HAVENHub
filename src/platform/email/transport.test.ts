import {
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
  TransientEmailError,
  resolveEmailTransport,
  type EmailMessage,
} from "./transport";
import { config } from "@/platform/config";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache, getSetting } from "@/platform/settings/service";

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

  // Maileroo can only sign for a domain verified in our account, so the From is
  // pinned to the configured sender. Honoring a per-template @yale.edu sender rule
  // would fail permanently on an unverified sending domain.
  it("ignores a per-message from and always sends as the configured sender", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send({ ...msg, from: "recruit@yale.edu" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(String(init.body));
    // The unverified @yale.edu address must never be the signed From...
    expect(parsed.from.address).toBe("noreply@havenfreeclinic.org");
    // ...but it is preserved as Reply-To so replies still reach a human.
    expect(parsed.reply_to.address).toBe("recruit@yale.edu");
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

  it("omits a redundant reply_to when the intended sender is already the pinned one", async () => {
    const fetchMock = vi.fn(async () => ok());
    await maileroo(fetchMock as typeof fetch).send({
      ...msg,
      from: "  NoReply@HavenFreeClinic.org  ",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).reply_to).toBeUndefined();
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

  it("returns a MailerooTransport when email.transport is maileroo and the key is set", async () => {
    await prisma.setting.create({ data: { key: "email.transport", value: "maileroo" } });
    await prisma.setting.create({ data: { key: "email.sender", value: "noreply@havenfreeclinic.org" } });
    _resetSettingsCache();
    const t = await withApiKey("test-key", resolveEmailTransport);
    expect(t).toBeInstanceOf(MailerooTransport);
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
  it("throws instead of degrading to log in production when the Maileroo key is missing", async () => {
    await prisma.setting.create({ data: { key: "email.transport", value: "maileroo" } });
    await prisma.setting.create({ data: { key: "email.sender", value: "noreply@havenfreeclinic.org" } });
    _resetSettingsCache();
    vi.stubEnv("VERCEL_ENV", "production");
    try {
      await withApiKey(undefined, async () => {
        await expect(resolveEmailTransport()).rejects.toThrow(/MAILEROO_API_KEY/);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("throws in production when maileroo is selected with no sender address", async () => {
    await prisma.setting.create({ data: { key: "email.transport", value: "maileroo" } });
    _resetSettingsCache();
    vi.stubEnv("VERCEL_ENV", "production");
    try {
      await withApiKey("test-key", async () => {
        await expect(resolveEmailTransport()).rejects.toThrow(/email\.sender/);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
