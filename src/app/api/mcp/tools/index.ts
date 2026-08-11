import type { z } from "zod";

/** The verified caller. Populated by the route from resolveIntercomIdentity, never from tool input. */
export type McpToolContext = { personId: string };

export type McpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Returns the answer as plain text. Return computed answers, never raw rows. */
  run: (ctx: McpToolContext, args: Record<string, unknown>) => Promise<string>;
};

/**
 * Input names that would let the model choose whose data is read.
 *
 * Kept deliberately broad: a false positive costs one rename, a false negative
 * costs the whole identity model. See the registry test.
 */
export const IDENTITY_ARGUMENT_PATTERN = /person|people|user|member|netid|actor|requester|assignee|email/i;

/**
 * Field names that must never appear in tool output. Tool responses can be
 * rendered straight into the chat and shared with the member, and these are the
 * values the spec forbids leaving the Hub at all. Phase 2 and later tools assert
 * their rendered output against this.
 */
export const FORBIDDEN_OUTPUT_PATTERN = /govId|dateOfBirth|photoKey|MemberLoginToken|passwordHash/i;

/**
 * Every tool Fin may call. Tools live here in the app layer rather than under
 * src/platform/intercom because import/no-restricted-paths forbids platform
 * code from importing src/modules, and forbids modules from importing each
 * other. A surface spanning schedule, compliance, roster, and recruitment can
 * only be composed where both are legal imports.
 */
export const MCP_TOOLS: McpTool[] = [];
