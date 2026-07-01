import { describe, it, expect, vi } from "vitest";
import { GraphTeamsTransport, LogTeamsTransport } from "./teams-transport";

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
