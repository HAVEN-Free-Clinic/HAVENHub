import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/platform/intercom/identity", () => ({ resolveIntercomIdentity: vi.fn() }));
vi.mock("@/platform/intercom/audit", () => ({ recordToolCall: vi.fn() }));

// Fakes mcp-handler's factory contract closely enough to prove the route wires
// identity through it: capture the tool handler `registerTool` receives, then
// invoke it exactly as the real SDK would -- with no per-call access to the
// request. If a tool ever needs the caller's identity, it must already be
// closed over by the time `registerTool` runs.
vi.mock("mcp-handler", () => ({
  createMcpHandler: vi.fn((initializeServer: (server: unknown) => void | Promise<void>) => {
    return async (_request: Request) => {
      let capturedHandler: ((args: Record<string, unknown>, ctx: unknown) => Promise<unknown>) | undefined;
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
      const result = await capturedHandler?.({}, {});
      return Response.json(result ?? {});
    };
  }),
}));

// A single fake tool so tests can assert exactly what personId it was called
// with, without exercising the real my_next_shift tool's DB access.
vi.mock("./tools", () => ({
  MCP_TOOLS: [
    {
      name: "test_tool",
      title: "Test Tool",
      description: "A fake tool for route-level identity tests.",
      inputSchema: {},
      run: vi.fn().mockResolvedValue("test result"),
    },
  ],
}));

import { resolveIntercomIdentity } from "@/platform/intercom/identity";
import { recordToolCall } from "@/platform/intercom/audit";
import { MCP_TOOLS } from "./tools";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function req(headers: Record<string, string>) {
  return new Request("https://hub.test/api/mcp", { method: "POST", headers });
}

beforeEach(() => {
  vi.resetAllMocks();
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
    const res = await POST(req({}));
    expect(res.status).toBe(404);
  });

  it("401s and audits without the bearer token", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ "X-Intercom-Person-Id": "p1" }));
    expect(res.status).toBe(401);
    expect(mocked(recordToolCall)).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied", personId: null })
    );
  });

  it("401s and audits with the wrong bearer token", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      req({ Authorization: "Bearer wrong", "X-Intercom-Person-Id": "p1" })
    );
    expect(res.status).toBe(401);
    expect(mocked(recordToolCall)).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied", personId: null })
    );
  });

  it("403s and audits when the identity claim does not verify", async () => {
    mocked(resolveIntercomIdentity).mockResolvedValue({ ok: false, reason: "unverified" });
    const { POST } = await import("./route");

    const res = await POST(
      req({ Authorization: "Bearer bearer-token", "X-Intercom-Person-Id": "p1" })
    );

    expect(res.status).toBe(403);
    expect(mocked(recordToolCall)).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unverified", personId: null })
    );
  });

  it("403s, audits, and never calls resolveIntercomIdentity when no identity header is present at all", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ Authorization: "Bearer bearer-token" }));
    expect(res.status).toBe(403);
    expect(mocked(resolveIntercomIdentity)).not.toHaveBeenCalled();
    expect(mocked(recordToolCall)).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unverified", personId: null })
    );
  });

  it("passes a tool the personId guard() verified, never a re-derived one", async () => {
    // Echoes the claim back as the verified id, the same shape a real
    // successful lookup takes (person.id resolves to the claimed id).
    mocked(resolveIntercomIdentity).mockImplementation(async (claimed: string) => ({
      ok: true,
      personId: claimed,
      name: null,
    }));
    const { POST } = await import("./route");

    await POST(
      req({ Authorization: "Bearer bearer-token", "X-Intercom-Person-Id": "verified-person" })
    );

    const runMock = mocked((MCP_TOOLS[0] as { run: unknown }).run);
    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({ personId: "verified-person" }),
      expect.anything()
    );
  });

  it("never lets a thrown tool error reach the response, and still audits the call as denied", async () => {
    mocked(resolveIntercomIdentity).mockImplementation(async (claimed: string) => ({
      ok: true,
      personId: claimed,
      name: null,
    }));
    // A realistic leak: Prisma/pg errors against an unreachable DB name the
    // Neon host (see db-unreachable-degradation), and the MCP SDK is documented
    // to turn an uncaught tool exception into a 200 whose body echoes
    // error.message straight back to Fin -- which Intercom may show the member.
    const leakyError = new Error(
      "connect ECONNREFUSED ep-dawn-mode-123.us-east-2.aws.neon.tech:5432 password=hunter2"
    );
    const runMock = mocked((MCP_TOOLS[0] as { run: unknown }).run);
    runMock.mockRejectedValueOnce(leakyError);

    const { POST } = await import("./route");
    const res = await POST(
      req({ Authorization: "Bearer bearer-token", "X-Intercom-Person-Id": "verified-person" })
    );

    const body = (await res.json()) as { content?: { type: string; text: string }[] };
    const text = body.content?.[0]?.text ?? "";

    expect(text).toBe("Sorry, I could not look that up right now.");
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("neon.tech");
    expect(text).not.toContain("hunter2");

    expect(mocked(recordToolCall)).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "test_tool", outcome: "denied", personId: "verified-person" })
    );
  });
});
