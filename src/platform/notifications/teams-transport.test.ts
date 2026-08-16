import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  GraphTeamsTransport,
  LogTeamsTransport,
  resolveTeamsTransport,
} from "./teams-transport";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache } from "@/platform/settings/service";

describe("LogTeamsTransport", () => {
  it("returns a synthetic chat id, flags logged, and never calls the network", async () => {
    const r = await new LogTeamsTransport().send({
      recipientUserId: "u1",
      chatId: null,
      bodyHtml: "<p>hi</p>",
    });
    expect(r.chatId).toBeTruthy();
    expect(r.logged).toBe(true);
  });
});

describe("GraphTeamsTransport", () => {
  it("creates a 1:1 chat then posts the message when no chatId is cached", async () => {
    const fetchImpl = vi
      .fn()
      // POST /chats -> returns new chat id
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "chat-1" }) })
      // POST /chats/{id}/messages -> ok
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "msg-1" }) });

    const transport = new GraphTeamsTransport({
      getAccessToken: async () => "tok",
      senderUpn: "hfc.admin@yale.edu",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await transport.send({
      recipientUserId: "entra-recipient",
      chatId: null,
      bodyHtml: "<p>hello</p>",
    });

    expect(result.chatId).toBe("chat-1");
    expect(result.logged).toBeFalsy();

    const [chatUrl, chatInit] = fetchImpl.mock.calls[0];
    expect(chatUrl).toBe("https://graph.microsoft.com/v1.0/chats");
    const chatBody = JSON.parse((chatInit as RequestInit).body as string);
    expect(chatBody.chatType).toBe("oneOnOne");
    expect(chatBody.members).toHaveLength(2);
    expect(JSON.stringify(chatBody.members)).toContain("hfc.admin@yale.edu");
    expect(JSON.stringify(chatBody.members)).toContain("entra-recipient");

    const [msgUrl, msgInit] = fetchImpl.mock.calls[1];
    expect(msgUrl).toBe("https://graph.microsoft.com/v1.0/chats/chat-1/messages");
    const msgBody = JSON.parse((msgInit as RequestInit).body as string);
    expect(msgBody.body.contentType).toBe("html");
    expect(msgBody.body.content).toBe("<p>hello</p>");
  });

  it("reuses a cached chatId and skips chat creation", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "msg-1" }) });
    const transport = new GraphTeamsTransport({
      getAccessToken: async () => "tok",
      senderUpn: "hfc.admin@yale.edu",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await transport.send({
      recipientUserId: "entra-recipient",
      chatId: "chat-existing",
      bodyHtml: "<p>hi</p>",
    });
    expect(result.chatId).toBe("chat-existing");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://graph.microsoft.com/v1.0/chats/chat-existing/messages"
    );
  });

  it("throws when the message POST is not ok", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "chat-1" }) })
      .mockResolvedValueOnce({ ok: false, status: 403, text: async () => "forbidden" });
    const transport = new GraphTeamsTransport({
      getAccessToken: async () => "tok",
      senderUpn: "s@y.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      transport.send({ recipientUserId: "r", chatId: null, bodyHtml: "<p>x</p>" })
    ).rejects.toThrow(/403/);
  });
});

// ---------------------------------------------------------------------------
// resolveTeamsTransport (#133): a graph-selected-but-unconnected mailer must not
// silently degrade to the log transport in production, because drainTeamsQueue
// then records the row LOGGED (terminal success) and never fires the email
// fallback. Mirrors resolveEmailTransport's production refusal.
// ---------------------------------------------------------------------------

describe("resolveTeamsTransport", () => {
  beforeEach(async () => {
    await resetDb();
    _resetSettingsCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetSettingsCache();
  });

  async function setTransport(value: "log" | "graph" | "maileroo") {
    await prisma.setting.create({ data: { key: "email.transport", value } });
    _resetSettingsCache();
  }

  /** Store a mailer credential so mailConnectionStatus() reports connected. */
  async function connectMailer() {
    await prisma.mailCredential.create({
      data: { id: "mailer", refreshToken: "refresh-token", account: "hfc.it@yale.edu" },
    });
  }

  it("returns the log transport when email.transport is log", async () => {
    await setTransport("log");
    vi.stubEnv("NODE_ENV", "production"); // even in prod, log mode is fine
    const t = await resolveTeamsTransport();
    expect(t).toBeInstanceOf(LogTeamsTransport);
  });

  // Teams DMs only ever go over Graph, so a non-graph EMAIL transport says
  // nothing about how a DM is sent -- it only says the deployment is live. When
  // this keyed off `=== "graph"`, selecting maileroo silently handed every DM to
  // LogTeamsTransport, which *succeeds*: drainTeamsQueue marks the row LOGGED
  // (terminal success), never retries, and never fires the email fallback, so the
  // recipient is reached on no channel while the monitor stays green.
  it("does not silently degrade Teams to the log transport when maileroo is selected", async () => {
    await setTransport("maileroo");
    vi.stubEnv("NODE_ENV", "production");
    await expect(resolveTeamsTransport()).rejects.toThrow(/no mailer account is connected/);
  });

  it("uses Graph for Teams when maileroo is selected and the mailer is connected", async () => {
    await setTransport("maileroo");
    await connectMailer();
    vi.stubEnv("NODE_ENV", "production");
    const t = await resolveTeamsTransport();
    expect(t).toBeInstanceOf(GraphTeamsTransport);
  });

  it("falls back to the log transport in dev/CI when graph is selected but the mailer is not connected", async () => {
    await setTransport("graph");
    // No MailCredential row -> mailConnectionStatus() reports not connected.
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "");
    const t = await resolveTeamsTransport();
    expect(t).toBeInstanceOf(LogTeamsTransport);
  });

  it("throws in production when graph is selected but the mailer is not connected", async () => {
    await setTransport("graph");
    vi.stubEnv("NODE_ENV", "production");
    await expect(resolveTeamsTransport()).rejects.toThrow(/no mailer account is connected/);
  });

  it("throws when VERCEL_ENV is production even if NODE_ENV is not", async () => {
    await setTransport("graph");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(resolveTeamsTransport()).rejects.toThrow(/refusing to route Teams DMs/);
  });
});
