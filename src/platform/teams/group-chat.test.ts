import { describe, expect, it, vi } from "vitest";
import {
  lookupUserId,
  createGroupChat,
  addChatMember,
  postChatMessage,
  GraphChatError,
} from "./group-chat";

const deps = (fetchImpl: typeof fetch) => ({ fetchImpl, getToken: async () => "tok" });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("lookupUserId", () => {
  it("returns the object id of a directory match", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: [{ id: "oid-1" }] }));
    const id = await lookupUserId("gl123@yale.edu", deps(fetchImpl as unknown as typeof fetch));
    expect(id).toBe("oid-1");
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("userPrincipalName%20eq%20'gl123%40yale.edu'");
    expect(url).toContain("mail%20eq%20'gl123%40yale.edu'");
  });

  it("returns null when the directory has no match", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: [] }));
    expect(await lookupUserId("nobody@yale.edu", deps(fetchImpl as unknown as typeof fetch))).toBeNull();
  });

  it("returns null rather than throwing on a 404", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: {} }, 404));
    expect(await lookupUserId("nobody@yale.edu", deps(fetchImpl as unknown as typeof fetch))).toBeNull();
  });

  it("escapes a single quote so a name cannot break the filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: [] }));
    await lookupUserId("o'brien@yale.edu", deps(fetchImpl as unknown as typeof fetch));
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain("o''brien");
  });
});

describe("createGroupChat", () => {
  it("posts a group chat with a topic and one member entry each", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: "chat-1", webUrl: "https://teams.microsoft.com/l/chat/1" }),
    );
    const result = await createGroupChat(
      { topic: "05.30.26 Ancillary Triage Chat", memberIds: ["oid-1", "oid-2"] },
      deps(fetchImpl as unknown as typeof fetch),
    );
    expect(result).toEqual({ chatId: "chat-1", webUrl: "https://teams.microsoft.com/l/chat/1" });

    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.chatType).toBe("group");
    expect(body.topic).toBe("05.30.26 Ancillary Triage Chat");
    expect(body.members).toHaveLength(2);
    expect(body.members[0]["user@odata.bind"]).toBe(
      "https://graph.microsoft.com/v1.0/users('oid-1')",
    );
    expect(body.members[0].roles).toEqual(["owner"]);
  });

  it("throws a GraphChatError carrying the response body", async () => {
    const fetchImpl = vi.fn(async () => new Response("member not found", { status: 400 }));
    await expect(
      createGroupChat({ topic: "t", memberIds: ["oid-1"] }, deps(fetchImpl as unknown as typeof fetch)),
    ).rejects.toMatchObject({ status: 400, body: "member not found" });
    await expect(
      createGroupChat({ topic: "t", memberIds: ["oid-1"] }, deps(fetchImpl as unknown as typeof fetch)),
    ).rejects.toBeInstanceOf(GraphChatError);
  });

  it("refuses to call Graph with no members", async () => {
    const fetchImpl = vi.fn();
    await expect(
      createGroupChat({ topic: "t", memberIds: [] }, deps(fetchImpl as unknown as typeof fetch)),
    ).rejects.toThrow(/at least one member/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("addChatMember", () => {
  it("posts one member to the chat", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 201 }));
    await addChatMember("chat-1", "oid-9", deps(fetchImpl as unknown as typeof fetch));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://graph.microsoft.com/v1.0/chats/chat-1/members");
    const body = JSON.parse(String(init.body));
    expect(body["user@odata.bind"]).toBe("https://graph.microsoft.com/v1.0/users('oid-9')");
  });

  it("throws with the status and body when Graph refuses", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(
      addChatMember("chat-1", "oid-9", deps(fetchImpl as unknown as typeof fetch)),
    ).rejects.toMatchObject({ status: 403, body: "forbidden" });
  });
});

describe("postChatMessage", () => {
  it("posts an html body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "m-1" }, 201));
    await postChatMessage("chat-1", "<p>hi</p>", deps(fetchImpl as unknown as typeof fetch));
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      body: { contentType: "html", content: "<p>hi</p>" },
    });
  });
});
