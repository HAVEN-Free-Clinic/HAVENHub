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
 * Zod schema "type" tags (schema._def.type) with no reachable substructure at
 * all -- a string, a number, a literal, and so on. These terminate the scan
 * safely: there is no nested shape for a key name to hide inside. Kept as a
 * tag-string allowlist rather than a chain of `instanceof` checks because
 * zod's string-format subtypes (ZodEmail, ZodUUID, ZodURL, ...) do not extend
 * ZodString at runtime even though they validate strings -- _def.type is the
 * one thing every scalar schema agrees on.
 */
const SCALAR_LEAF_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "date",
  "bigint",
  "enum",
  "literal",
  "null",
  "undefined",
  "any",
  "unknown",
  "nan",
  "void",
  "symbol",
  "file",
  "template_literal",
]);

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
 * silently under-checked. Unions, intersections, lazy schemas, tuples, and
 * pipes (".transform()"/".pipe()"/".preprocess()") are traversed into rather
 * than treated as opaque, and any schema type this function still does not
 * recognise throws rather than silently contributing no keys -- a guard that
 * cannot see a shape must refuse it, not wave it through.
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
  // z.union and z.discriminatedUnion (the latter extends the former at
  // runtime, so this branch catches both): a personId hidden in ANY option is
  // reachable, because Fin's actual call only has to satisfy one arm.
  if (schema instanceof z.ZodUnion) {
    const options = schema._def.options as z.ZodTypeAny[];
    return options.flatMap((option, i) => collectSchemaKeys(option, `${path}|${i}`));
  }
  if (schema instanceof z.ZodIntersection) {
    return [
      ...collectSchemaKeys(schema._def.left as z.ZodTypeAny, path),
      ...collectSchemaKeys(schema._def.right as z.ZodTypeAny, path),
    ];
  }
  // z.lazy defers building the inner schema until called, which is how zod
  // supports self-referential shapes. Calling the getter is the only way to
  // see what it actually validates.
  if (schema instanceof z.ZodLazy) {
    return collectSchemaKeys(schema._def.getter() as z.ZodTypeAny, path);
  }
  if (schema instanceof z.ZodTuple) {
    const items = schema._def.items as z.ZodTypeAny[];
    const rest = schema._def.rest as z.ZodTypeAny | null;
    return [
      ...items.flatMap((item, i) => collectSchemaKeys(item, `${path}[${i}]`)),
      ...(rest ? collectSchemaKeys(rest, `${path}[...]`) : []),
    ];
  }
  // zod v4's ".transform()", ".pipe()", and ".preprocess()" all compile to a
  // ZodPipe (v3's ZodEffects no longer exists as a distinct wrapper here;
  // ".refine()" and ".superRefine()" attach a check to the existing schema in
  // place instead, so a refined ZodObject is still, structurally, a
  // ZodObject and already handled above). Only the validated INPUT side of a
  // pipe is a real schema shape; the output side is whatever the transform
  // function computes and has no static keys to scan.
  if (schema instanceof z.ZodPipe) {
    return collectSchemaKeys(schema._def.in as z.ZodTypeAny, path);
  }
  if (SCALAR_LEAF_SCHEMA_TYPES.has(schema._def.type)) {
    return [];
  }
  // A shape this function does not know how to look inside of is exactly the
  // blind spot the guard exists to close: silently returning [] here would
  // let a personId hidden in some zod construct this function has not been
  // taught about sail past every test that calls it, with no error at all.
  // Refuse it instead -- a future tool must either avoid the construct or
  // extend this function, not slip through unnoticed.
  throw new Error(
    `Schema at "${path || "<root>"}" is a "${schema._def.type}" zod type the identity guard does not recognise. Teach collectSchemaKeys its shape, or restructure the tool's input schema.`
  );
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
