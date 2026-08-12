import { z } from "zod";
import { myNextShiftTool } from "./scheduling";
import { myClearanceStatusTool } from "./compliance";
import { myOutstandingTrainingTool } from "./training";
import { departmentRosterTool, memberStatusTool } from "./roster";
import { recruitmentCycleStatusTool, myApplicationStatusTool } from "./recruitment";

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
 * Input names that would let a tool's input ASSERT the caller's identity
 * (a `name`, `netId`, or similar the model could fill in to claim to be
 * looking up someone in particular), rather than merely read as an ordinary
 * lookup argument.
 *
 * This is not the cross-person protection -- it never was, past phase 2.
 * memberStatusTool's `name` input deliberately does NOT match this pattern:
 * Phase 3 tools legitimately take a person's name or netId as a search term
 * for someone OTHER than the caller (see roster.ts's file-level comment),
 * and the real guard against a caller reading a person outside their scope
 * is authorization -- hasPlatformScope/permissionDepartmentIds, checked
 * inside each tool's run(). What this pattern actually catches is a tool
 * whose schema takes an argument like `personId` or `actorId` that the
 * caller's own identity is supposed to come from instead (always the
 * verified conversation, never a tool argument -- see McpToolContext).
 *
 * Kept deliberately broad: a false positive costs one rename, a false negative
 * costs the whole identity model. See the registry test. These patterns are
 * CI-time assertions against the schemas tools declare today, not a runtime
 * invariant enforced on every call -- a tool added later with a differently-
 * named identity-assertion argument would need its own test coverage or a
 * pattern update, not just reliance on this regex catching it automatically.
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
 *
 * `govId` is no longer a column anywhere in the schema (TechRequest.govId was
 * removed as dead: it was written in one place and nothing ever supplied it).
 * The name-match stays in this pattern anyway -- it costs nothing, and a future
 * field reintroducing that name (on TechRequest or elsewhere) is exactly the
 * case this guard exists to catch without anyone having to remember to add it
 * back.
 */
export const FORBIDDEN_OUTPUT_PATTERN = /govId|dateOfBirth|photoKey|MemberLoginToken|passwordHash|storageKey|scormBlobKey/i;

/**
 * Government-ID-shaped VALUES: a bare 9-digit run (an SSN with no separators)
 * or the NNN-NN-NNNN dashed form. FORBIDDEN_OUTPUT_PATTERN, above, only
 * matches field NAMES and would miss this entirely once a tool formats a
 * govId into a sentence -- by then the field name is gone and only the shape
 * of the value is left to catch it. `\b...\b` matters here: without it,
 * `\d{9}` would also match nine digits out of a longer run, which is not
 * what an SSN-shaped value looks like.
 *
 * Kept even though TechRequest.govId itself has been removed as a dead column
 * (it never held a value): this pattern guards the VALUE shape, not any one
 * column, so it still catches an SSN-shaped string surfacing from any other
 * source a future tool might render -- a date of birth, a different table, a
 * comment someone pasted one into. The final review of this codebase found
 * this and DOB_VALUE_PATTERN below to be the only thing standing between a
 * serialized object and Fin, which is reason enough to keep both regardless
 * of what govId's column status is at any given moment.
 */
const GOV_ID_VALUE_PATTERN = /\b\d{9}\b|\b\d{3}-\d{2}-\d{4}\b/;

/**
 * Date-of-birth-shaped VALUES: a plain ISO calendar date (YYYY-MM-DD).
 * Deliberately narrower than "three dash-separated number groups" so it does
 * not fire on the answers tools actually return: clinic dates render through
 * formatCalendarDate as "Sep 12, 2026" (see myNextShiftTool), never as ISO,
 * and ticket numbers are short bare integers with no dashes at all.
 */
const DOB_VALUE_PATTERN = /\b\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/;

/**
 * Value-level companion to FORBIDDEN_OUTPUT_PATTERN. That check can only
 * catch an accidental object dump, because it matches field NAMES -- it would
 * wave straight through a tool that formats a real govId or date of birth
 * into prose, which is the actual risk once a tool renders a record into a
 * sentence instead of returning raw fields. Wired into every tool's output in
 * the route wrapper (see registerTools in route.ts), so no tool can opt out
 * of it and no tool author has to remember to call it themselves.
 *
 * FORBIDDEN_OUTPUT_PATTERN itself is checked here too, not just documented as
 * a guard elsewhere -- it had no runtime call site before this, which meant an
 * accidental `JSON.stringify(person)` (the exact shape it exists to catch)
 * sailed through untouched: the value patterns above only cover a govId or a
 * date of birth actually rendered into prose, and a raw DateTime field like
 * `"dateOfBirth":"1998-04-12T00:00:00.000Z"` does not even match
 * DOB_VALUE_PATTERN's `\b...\b` (the digits run straight into `T`, so there is
 * no word boundary there). No false-positive risk: none of the seven field
 * names it matches can appear in a department name, course title, cycle
 * title, or status label -- the only kinds of prose these tools generate.
 *
 * Throws rather than returning a boolean so the route wrapper can route a
 * trip through the exact same catch/audit path as a thrown tool error (see
 * TOOL_FAILURE_MESSAGE there) -- the offending text must never reach the
 * returned content, including inside a thrown error's own message, so this
 * only reports that the check tripped and never what tripped it.
 */
export function assertSafeToolOutput(text: string): void {
  if (
    FORBIDDEN_OUTPUT_PATTERN.test(text) ||
    GOV_ID_VALUE_PATTERN.test(text) ||
    DOB_VALUE_PATTERN.test(text)
  ) {
    throw new Error("Tool output blocked by the value-level output guard.");
  }
}

/**
 * Every tool Fin may call. Tools live here in the app layer rather than under
 * src/platform/intercom because import/no-restricted-paths forbids platform
 * code from importing src/modules, and forbids modules from importing each
 * other. A surface spanning schedule, compliance, roster, and recruitment can
 * only be composed where both are legal imports.
 */
export const MCP_TOOLS: McpTool[] = [
  myNextShiftTool,
  myClearanceStatusTool,
  myOutstandingTrainingTool,
  departmentRosterTool,
  memberStatusTool,
  recruitmentCycleStatusTool,
  myApplicationStatusTool,
];
