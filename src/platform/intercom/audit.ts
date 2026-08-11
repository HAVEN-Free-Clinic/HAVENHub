import { recordAudit } from "@/platform/audit";

/**
 * One audit row per MCP tool call.
 *
 * This is the primary detection mechanism for the identity binding being
 * misconfigured in Intercom. A burst of `intercom_mcp.unverified` rows, or one
 * person appearing as the actor for implausibly many distinct calls, is what
 * that failure looks like from here -- nothing in the codebase can see the
 * Intercom-side setting directly.
 */
export async function recordToolCall(params: {
  personId: string | null;
  tool: string;
  args: Record<string, unknown>;
  outcome: "ok" | "denied" | "unverified";
}): Promise<void> {
  await recordAudit({
    actorPersonId: params.personId,
    action: `intercom_mcp.${params.outcome}`,
    entityType: "IntercomMcpToolCall",
    entityId: params.tool,
    after: { tool: params.tool, args: params.args, outcome: params.outcome },
  });
}
