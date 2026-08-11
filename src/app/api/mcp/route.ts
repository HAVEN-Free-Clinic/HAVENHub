import { createMcpHandler } from "mcp-handler";
import type { McpServer } from "@modelcontextprotocol/server";
import { isMcpConfigured, mcpBearerToken } from "@/platform/intercom/config";
import { resolveIntercomIdentity } from "@/platform/intercom/identity";
import { recordToolCall } from "@/platform/intercom/audit";
import { MCP_TOOLS } from "./tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Header Fin sets from the verified contact attribute. Never a tool argument. */
const IDENTITY_HEADER = "X-Intercom-Person-Id";

/**
 * Registers every tool against one request's MCP server, closing over the
 * personId `guard()` already verified for that request.
 *
 * mcp-handler's tool callback gets no access to the original request or its
 * headers (its second argument, `ServerContext`, carries protocol plumbing
 * only -- no `requestInfo`). So identity cannot be re-derived inside the
 * callback; it must already be in scope. Building the server fresh per
 * request and closing over `personId` here is what makes that structurally
 * true: there is no code path in which a tool sees an unverified caller,
 * because the only personId a tool can ever reach is the one guard() proved.
 */
function registerTools(server: McpServer, personId: string): void {
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async (args) => {
        const text = await tool.run({ personId }, args);
        await recordToolCall({ personId, tool: tool.name, args, outcome: "ok" });
        return { content: [{ type: "text" as const, text }] };
      }
    );
  }
}

/**
 * Gate every request before it reaches the MCP machinery, and hand back the
 * identity it verified so the caller can build a server scoped to it.
 *
 * Bearer auth proves the caller is our Fin connector. The identity header
 * proves which member the conversation belongs to, and is verified against
 * Intercom rather than trusted. Both must pass; there is no anonymous or
 * reduced-scope path, because a caller we cannot identify is one we cannot
 * authorize.
 */
async function guard(request: Request): Promise<Response | { personId: string }> {
  if (!isMcpConfigured()) {
    return Response.json({ error: "Not Found" }, { status: 404 });
  }

  const expected = mcpBearerToken();
  const presented = request.headers.get("authorization");
  if (!expected || presented !== `Bearer ${expected}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const claimed = request.headers.get(IDENTITY_HEADER);
  if (!claimed) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const identity = await resolveIntercomIdentity(claimed);
  if (!identity.ok) {
    await recordToolCall({ personId: null, tool: "(request)", args: {}, outcome: "unverified" });
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  return { personId: identity.personId };
}

/**
 * mcp-handler documents its factory as building one fresh McpServer per HTTP
 * request under createMcpHandler. That is what makes it safe to construct
 * the handler here, inside the request path, after guard() has already
 * resolved identity -- each request gets its own server, tools, and closure,
 * so nothing from one caller's personId can leak into another's request.
 */
async function handle(request: Request): Promise<Response> {
  const gate = await guard(request);
  if (gate instanceof Response) return gate;

  const handler = createMcpHandler((server) => registerTools(server, gate.personId));
  return handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
