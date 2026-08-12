import { createMcpHandler } from "mcp-handler";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isMcpConfigured, mcpBearerToken } from "@/platform/intercom/config";
import { resolveIdentityFromConversation, UNIDENTIFIED_MESSAGE } from "@/platform/intercom/identity";
import { recordToolCall } from "@/platform/intercom/audit";
import { constantTimeBearerMatch } from "@/platform/security";
import { log, errorAttrs } from "@/platform/logging";
import { MCP_TOOLS, assertSafeToolOutput } from "./tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The one reserved tool input, bound in Intercom to the conversation attribute.
 *
 * This was a request header until production proved Fin cannot send one: every
 * call 403'd because the header never arrived, while bearer auth passed. Fin's
 * custom MCP connector can only populate tool inputs, so identity had to move
 * into the schema.
 *
 * It carries a CONVERSATION id, never a person id, and that distinction is the
 * whole safety argument. The model cannot assert who it is; it can only name a
 * conversation, and the server asks Intercom who owns that conversation. A
 * swapped value therefore has to be another member's real conversation id, not
 * merely another member's id -- see resolveIdentityFromConversation.
 */
const CONVERSATION_ID_ARG = "conversation_id";

/**
 * Fixed, non-revealing text returned to the member when a tool throws.
 *
 * Intercom documents that any data a tool response carries may be shown
 * straight to the customer, so a raw error message (which in this codebase
 * regularly names the Neon host during a DB-unreachable condition -- see
 * db-unreachable-degradation) must never reach the response. The real error
 * goes to the server log only.
 */
const TOOL_FAILURE_MESSAGE = "Sorry, I could not look that up right now.";

/** Audit tool name for a request rejected before any specific tool ran (bad bearer, missing identity header). Distinguishes a request-level rejection from a named tool's own outcome. */
const REQUEST_LEVEL_TOOL = "(request)";

/**
 * Registers every tool against one request's MCP server.
 *
 * Identity is resolved per call rather than per request, because the
 * conversation id arrives inside the tool's own arguments and simply is not
 * available earlier. `guard()` still runs first, but it can only prove the
 * caller is our connector, not which member it is speaking for.
 *
 * The wrapper is the whole enforcement point. `tool.run` receives a personId
 * only on the path where resolveIdentityFromConversation returned ok, so a tool
 * cannot observe an unverified caller, and no tool implements identity handling
 * itself. The reserved argument is stripped before `run` sees the rest, so
 * tools never get the chance to use the raw conversation id for anything.
 */
function registerTools(server: McpServer): void {
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Injected here, centrally, rather than declared by each tool. A tool
        // author cannot forget it, cannot name it something else, and cannot
        // opt out -- and the registry's guard test keeps working unchanged,
        // because tools' own schemas still declare no identity-shaped input.
        inputSchema: tool.inputSchema.extend({
          [CONVERSATION_ID_ARG]: z
            .string()
            .describe(
              // Written AT the model, not at whoever configures the connector.
              // The first wording explained the binding ("bind this to the
              // conversation attribute"), and Fin responded by asking the
              // member to supply their own conversation ID -- it read the field
              // as something a human might know. A customer can never provide
              // this, and asking makes the assistant look broken. If the input
              // is left unbound the call should simply fail closed and be
              // audited, which is what the server already does.
              "Supplied automatically by the connector from the current conversation. Never ask the customer for this value, and never guess it. If it is not available, say you cannot look this up right now."
            ),
        }),
      },
      async (args) => {
        const { [CONVERSATION_ID_ARG]: conversationId, ...toolArgs } = (args ?? {}) as Record<
          string,
          unknown
        >;

        const identity =
          typeof conversationId === "string" && conversationId.length > 0
            ? await resolveIdentityFromConversation(conversationId)
            : ({ ok: false, reason: "no_conversation_id" } as const);

        if (!identity.ok) {
          // Audited with a null actor: we genuinely do not know who this was,
          // and a run of these is what an Intercom-side misconfiguration (an
          // input left on "let Fin decide", or unbound entirely) looks like
          // from here. The specific reason travels into the row too -- see
          // recordToolCall's doc comment for why that distinction matters
          // here even though UNIDENTIFIED_MESSAGE deliberately erases it.
          await recordToolCall({
            personId: null,
            tool: tool.name,
            args: toolArgs,
            outcome: "unverified",
            reason: identity.reason,
          });
          return { content: [{ type: "text" as const, text: UNIDENTIFIED_MESSAGE }] };
        }

        const personId = identity.personId;
        // "denied" is reserved for an actual authorization refusal -- a tool
        // that returns a plain refusal string (e.g. departmentRosterTool's
        // DEPARTMENT_ACCESS_DENIED) never throws, so it audits "ok" like any
        // other successful call; that string IS the outcome and this route
        // has no way to distinguish it from a real answer without inspecting
        // tool-specific text, which would be its own fragile coupling. "error"
        // is for the one thing this route CAN prove unconditionally: the tool
        // itself blew up. Collapsing that into "denied" (as it read before)
        // meant the audit trail could not tell "the caller was refused" from
        // "the tool crashed" -- see guard()'s own "denied" row for what a real
        // refusal looks like here.
        let outcome: "ok" | "denied" | "error" = "ok";
        let text: string;
        try {
          text = await tool.run({ personId }, toolArgs);
          // Value-level companion to the identity-argument guard above: proves
          // the rendered text itself does not carry a government-ID- or
          // date-of-birth-shaped value out to Fin, regardless of what field
          // name (if any) it came from. A trip here is handled exactly like a
          // thrown tool error -- same catch, same audit, same fixed message --
          // so the offending text can never reach the return value.
          assertSafeToolOutput(text);
        } catch (err) {
          // Never let the thrown error's message, stack, or cause reach the
          // returned content -- see TOOL_FAILURE_MESSAGE's doc comment for why.
          outcome = "error";
          log.error("[intercom-mcp] tool call failed", errorAttrs(err, { tool: tool.name }));
          text = TOOL_FAILURE_MESSAGE;
        } finally {
          // In finally so both success and failure get recorded -- a failing
          // tool call is exactly as important to audit as a succeeding one.
          await recordToolCall({ personId, tool: tool.name, args: toolArgs, outcome });
        }
        return { content: [{ type: "text" as const, text }] };
      }
    );
  }
}

/**
 * Gate every request before it reaches the MCP machinery.
 *
 * This proves the caller is our Fin connector and nothing more. It deliberately
 * no longer decides WHO the request speaks for: that depends on the conversation
 * id, which lives in a tool's arguments and is not visible at request level.
 * Identity is enforced in the tool wrapper instead (see registerTools).
 *
 * The distinction matters when reading this file: passing guard() is not
 * authorization, only authentication of the connector.
 */
async function guard(request: Request): Promise<Response | null> {
  if (!isMcpConfigured()) {
    return Response.json({ error: "Not Found" }, { status: 404 });
  }

  const expected = mcpBearerToken();
  const authHeader = request.headers.get("authorization");
  if (!expected || !constantTimeBearerMatch(authHeader, expected)) {
    // A wrong shared secret is not a legitimate Fin request at all, but it is
    // still worth a row: a run of these is what a misconfigured or stale
    // connector looks like from here. Only audited when a header was actually
    // presented, though -- this endpoint is publicly reachable once
    // configured, so a credential-free drive-by scanner would otherwise be
    // able to grow AuditLog for free. The webhook route makes the same call
    // for the same reason (see its rejected-signature branch: log.warn only,
    // never an audit row).
    if (authHeader) {
      await recordToolCall({ personId: null, tool: REQUEST_LEVEL_TOOL, args: {}, outcome: "denied" });
    }
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

/**
 * mcp-handler documents its factory as building one fresh McpServer per HTTP
 * request under createMcpHandler, so each request gets its own server and
 * tools. Nothing is closed over per-caller any more -- identity now resolves
 * inside each tool call -- but building per request keeps that property true
 * for anything added later.
 */
async function handle(request: Request): Promise<Response> {
  const denied = await guard(request);
  if (denied) return denied;

  const handler = createMcpHandler((server) => registerTools(server));
  return handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
