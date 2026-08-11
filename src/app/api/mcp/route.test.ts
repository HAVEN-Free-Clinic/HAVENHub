import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/platform/intercom/identity", () => ({ resolveIdentityFromConversation: vi.fn() }));
vi.mock("@/platform/intercom/audit", () => ({ recordToolCall: vi.fn() }));

/**
 * Shared holder so the hoisted mock factories below can reach values the tests
 * control. vi.mock factories are hoisted above imports, so they cannot close
 * over ordinary test-scope constants.
 */
const shared = vi.hoisted(() => ({
  /** Arguments the fake SDK hands the captured tool callback. */
  toolArgs: {} as Record<string, unknown>,
  /** The fake tool's run, so tests can assert what it received. */
  run: undefined as unknown as ReturnType<typeof vi.fn>,
}));

// Fakes mcp-handler's factory contract closely enough to prove the route wires
// identity through it: capture the callback `registerTool` receives, then invoke
// it exactly as the real SDK would -- with the tool's arguments and no access to
// the original request. The route must therefore derive identity from those
// arguments, which is the whole point of the conversation_id design.
vi.mock("mcp-handler", () => ({
  createMcpHandler: vi.fn((initializeServer: (server: unknown) => void | Promise<void>) => {
    return async (_request: Request) => {
      let capturedHandler:
        | ((args: Record<string, unknown>, ctx: unknown) => Promise<unknown>)
        | undefined;
      const fakeServer = {
        registerTool: (
          _name: string,
          _config: unknown,
          handler: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>
        ) => {
          capturedHandler = handler;
        },
      };
      await initializeServer(fakeServer);
      const result = await capturedHandler?.(shared.toolArgs, {});
      return Response.json(result ?? {});
    };
  }),
}));

// A single fake tool, with a REAL zod schema so the route's central injection of
// the reserved conversation_id argument is exercised rather than stubbed.
vi.mock("./tools", async () => {
  const { z } = await import("zod");
  const { vi: vitest } = await import("vitest");
  shared.run = vitest.fn().mockResolvedValue("test result");
  return {
    MCP_TOOLS: [
      {
        name: "test_tool",
        title: "Test Tool",
        description: "A fake tool for route-level identity tests.",
        inputSchema: z.object({}),
        run: shared.run,
      },
    ],
  };
});

import { resolveIdentityFromConversation } from "@/platform/intercom/identity";
import { recordToolCall } from "@/platform/intercom/audit";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function req(headers: Record<string, string>) {
  return new Request("https://hub.test/api/mcp", { method: "POST", headers });
}

const AUTHED = { Authorization: "Bearer bearer-token" };

beforeEach(() => {
  vi.clearAllMocks();
  shared.toolArgs = { conversation_id: "conv_123" };
  shared.run?.mockResolvedValue("test result");
  vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
  vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
  vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
  vi.stubEnv("INTERCOM_MCP_BEARER_TOKEN", "bearer-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/mcp", () => {
  it("404s when the MCP server is not configured", async () => {
    vi.stubEnv("INTERCOM_MCP_BEARER_TOKEN", "");
    const { POST } = await import("./route");
    const res = await POST(req(AUTHED));
    expect(res.status).toBe(404);
  });

  it("401s without the bearer token", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({}));
    expect(res.status).toBe(401);
  });

  it("401s with the wrong bearer token", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ Authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("refuses and audits when no conversation id is supplied", async () => {
    shared.toolArgs = {};
    const { POST } = await import("./route");

    const res = await POST(req(AUTHED));
    const body = await res.json();

    expect(JSON.stringify(body)).toContain("could not confirm who you are");
    expect(mocked(resolveIdentityFromConversation)).not.toHaveBeenCalled();
    expect(mocked(recordToolCall)).toHaveBeenCalledWith(
      expect.objectContaining({ personId: null, outcome: "unverified" })
    );
    expect(shared.run).not.toHaveBeenCalled();
  });

  it("refuses and audits when the conversation does not resolve to a member", async () => {
    mocked(resolveIdentityFromConversation).mockResolvedValue({ ok: false, reason: "unverified" });
    const { POST } = await import("./route");

    const res = await POST(req(AUTHED));
    const body = await res.json();

    expect(JSON.stringify(body)).toContain("could not confirm who you are");
    expect(mocked(recordToolCall)).toHaveBeenCalledWith(
      expect.objectContaining({ personId: null, outcome: "unverified" })
    );
    expect(shared.run).not.toHaveBeenCalled();
  });

  /**
   * The load-bearing one. A tool must receive the personId the server derived
   * from Intercom's record of the conversation, and must never see the raw
   * conversation id -- it is an identity credential, not tool input.
   */
  it("passes the tool the personId resolved from the conversation, and strips the raw id", async () => {
    mocked(resolveIdentityFromConversation).mockResolvedValue({
      ok: true,
      personId: "verified-person",
      name: "Sam Rivera",
    });
    shared.toolArgs = { conversation_id: "conv_123", limit: 5 };
    const { POST } = await import("./route");

    await POST(req(AUTHED));

    expect(mocked(resolveIdentityFromConversation)).toHaveBeenCalledWith("conv_123");
    expect(shared.run).toHaveBeenCalledWith({ personId: "verified-person" }, { limit: 5 });
    const passedArgs = shared.run.mock.calls[0][1] as Record<string, unknown>;
    expect(passedArgs).not.toHaveProperty("conversation_id");
    expect(mocked(recordToolCall)).toHaveBeenCalledWith(
      expect.objectContaining({ personId: "verified-person", outcome: "ok" })
    );
  });

  it("never lets a thrown tool error reach the response, and still audits it as denied", async () => {
    mocked(resolveIdentityFromConversation).mockResolvedValue({
      ok: true,
      personId: "verified-person",
      name: null,
    });
    shared.run.mockRejectedValue(
      new Error("Can't reach database server at ep-broad-brook.neon.tech:5432 password=hunter2")
    );
    const { POST } = await import("./route");

    const res = await POST(req(AUTHED));
    const body = JSON.stringify(await res.json());

    expect(body).toContain("could not look that up");
    expect(body).not.toContain("neon.tech");
    expect(body).not.toContain("hunter2");
    expect(mocked(recordToolCall)).toHaveBeenCalledWith(
      expect.objectContaining({ personId: "verified-person", outcome: "denied" })
    );
  });
});
