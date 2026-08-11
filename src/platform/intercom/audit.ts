import { Prisma } from "@prisma/client";
import { recordAudit } from "@/platform/audit";

/**
 * One audit row per MCP tool call.
 *
 * This is the primary detection mechanism for the identity binding being
 * misconfigured in Intercom. A burst of `intercom_mcp.unverified` rows, or one
 * person appearing as the actor for implausibly many distinct calls, is what
 * that failure looks like from here -- nothing in the codebase can see the
 * Intercom-side setting directly. That said, recordAudit is fire-and-forget on
 * its default (singleton) path (see src/platform/audit.ts), so a DB blip can
 * make a row silently never land; this mechanism detects a misconfiguration
 * that keeps happening, not necessarily every single occurrence of it.
 */
export async function recordToolCall(params: {
  personId: string | null;
  tool: string;
  args: Record<string, unknown>;
  outcome: "ok" | "denied" | "unverified";
}): Promise<void> {
  // Tool arguments are JSON-serializable by construction: they arrive as JSON
  // over the MCP transport, so we safely assert the payload to InputJsonValue.
  const payload = {
    tool: params.tool,
    args: params.args,
    outcome: params.outcome,
  } as Prisma.InputJsonValue;

  await recordAudit({
    actorPersonId: params.personId,
    action: `intercom_mcp.${params.outcome}`,
    entityType: "IntercomMcpToolCall",
    entityId: params.tool,
    after: payload,
  });
}
