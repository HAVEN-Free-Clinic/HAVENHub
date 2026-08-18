import { describe, expect, it, vi } from "vitest";
import {
  getSignedInUserId,
  createGroupChat,
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

describe("getSignedInUserId", () => {
  it("reads /me rather than querying the directory", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "oid-1" }));
    const id = await getSignedInUserId(deps(fetchImpl as unknown as typeof fetch));
    expect(id).toBe("oid-1");
    // The point of the whole call: /me needs only User.Read, so the request must
    // never reach /users, which would put the app back on User.ReadBasic.All.
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toBe("https://graph.microsoft.com/v1.0/me?$select=id");
    expect(url).not.toContain("$filter");
  });

  it("returns null when Graph answers without an id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    expect(await getSignedInUserId(deps(fetchImpl as unknown as typeof fetch))).toBeNull();
  });

  it("throws a GraphChatError when the token is refused", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(
      getSignedInUserId(deps(fetchImpl as unknown as typeof fetch)),
    ).rejects.toMatchObject({ status: 403, body: "forbidden" });
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
