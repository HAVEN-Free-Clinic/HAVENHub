import { z } from "zod";
import { myNextShiftTool } from "./scheduling";

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
export const IDENTITY_ARGUMENT_PATTERN = /person|people|user|member|netid|actor|requester|assignee|email|contact|identity/i;

/**
 * Every key name reachable in a Zod object schema, including inside nested
 * ZodObjects, so the identity-argument guard cannot be defeated by nesting a
 * person id under an unrelated wrapper key (e.g. `filter.personId`). A flat
 * `Object.keys(schema.shape)` scan only sees the top level and would let a
 * nested offender through unnoticed.
 *
 * z.record, and any object whose catchall is not ZodNever (an explicit
 * `.passthrough()`, or a custom `.catchall(...)`), admit key names beyond
 * whatever the schema declares. No enumeration of declared keys can bound an
 * open-ended shape like that, so those are rejected outright rather than
 * silently under-checked.
 */
export function collectSchemaKeys(schema: z.ZodTypeAny, path = ""): string[] {
  if (schema instanceof z.ZodRecord) {
    throw new Error(
      `Schema at "${path || "<root>"}" is a z.record, which admits arbitrary key names the identity guard cannot enumerate.`
    );
  }
  if (schema instanceof z.ZodObject) {
    const catchall = schema._def.catchall;
    if (catchall && !(catchall instanceof z.ZodNever)) {
      throw new Error(
        `Schema at "${path || "<root>"}" allows unknown keys (passthrough or a custom catchall), which the identity guard cannot enumerate.`
      );
    }
    return Object.entries(schema.shape).flatMap(([key, value]) => {
      const childPath = path ? `${path}.${key}` : key;
      return [key, ...collectSchemaKeys(value as z.ZodTypeAny, childPath)];
    });
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    return collectSchemaKeys(schema._def.innerType as z.ZodTypeAny, path);
  }
  if (schema instanceof z.ZodArray) {
    return collectSchemaKeys(schema._def.element as z.ZodTypeAny, path);
  }
  return [];
}

/**
 * Field names that must never appear in tool output. Tool responses can be
 * rendered straight into the chat and shared with the member, and these are the
 * values the spec forbids leaving the Hub at all. Phase 2 and later tools assert
 * their rendered output against this.
 */
export const FORBIDDEN_OUTPUT_PATTERN = /govId|dateOfBirth|photoKey|MemberLoginToken|passwordHash|storageKey|scormBlobKey/i;

/**
 * Every tool Fin may call. Tools live here in the app layer rather than under
 * src/platform/intercom because import/no-restricted-paths forbids platform
 * code from importing src/modules, and forbids modules from importing each
 * other. A surface spanning schedule, compliance, roster, and recruitment can
 * only be composed where both are legal imports.
 */
export const MCP_TOOLS: McpTool[] = [myNextShiftTool];
