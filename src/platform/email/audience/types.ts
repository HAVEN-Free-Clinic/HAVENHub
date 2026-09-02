import type { DisplayTimeZone } from "@/platform/dates/zone";

export type AudienceRecordType = "PERSON"; // extensible: future "APPLICANT"
export type ConditionOp =
  | "eq"
  | "in"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "isEmpty"
  | "isNotEmpty"
  | "isTrue"
  | "isFalse"
  // Negative operators. Every one of these carries a sharper version of the
  // blank-value hazard the positive operators have: a positive filter with a
  // missing value narrows to nothing (annoying), while a NEGATIVE filter with a
  // missing value widens to EVERYONE (a send-all). `operators.ts` is the single
  // place that guarantees a blank value compiles to match-nobody instead.
  | "notEq"
  | "notIn"
  | "notContains"
  // Ordered comparison, used by year-kind fields (see gradYear) and, together
  // with `lte`/`gte`, by count-kind fields (see countWhere in operators.ts).
  | "lt"
  | "gt"
  | "lte"
  | "gte"
  // Date operators. `before`/`after`/`onOrBefore`/`onOrAfter`/`between` take
  // calendar dates ("YYYY-MM-DD") and resolve against the clinic's display zone.
  // `withinNextDays`/`withinLastDays` take a whole number of days and resolve
  // against `now` AT RESOLVE TIME, which is what lets a recurring campaign mean
  // something different on each run.
  | "before"
  | "after"
  | "onOrBefore"
  | "onOrAfter"
  | "between"
  | "withinNextDays"
  | "withinLastDays";

/** Operators that take no value; the builder shows no value control for these. */
export const VALUELESS_OPS: ConditionOp[] = ["isEmpty", "isNotEmpty", "isTrue", "isFalse"];

/**
 * Operators whose match set is the COMPLEMENT of their value. Callers that need
 * to reason about send-blast risk (and the builder, when it warns) ask here
 * rather than re-listing the negative operators and drifting out of sync.
 */
export const NEGATIVE_OPS: ConditionOp[] = ["notEq", "notIn", "notContains", "isFalse"];

export function isNegativeOp(op: ConditionOp): boolean {
  return NEGATIVE_OPS.includes(op);
}

/**
 * Field keys whose condition VALUE is a list of RecruitmentCycle ids.
 *
 * Stated once because THREE separate places have to agree about it and each
 * fails differently when they drift:
 *
 *   - `buildAudienceCtx` (resolve.ts) collects the named cycle ids into the
 *     pre-seeded buckets. A field missing here gets a bucket map with no key
 *     for its cycle, which resolves to match-nobody -- silent under ALL/ANY and
 *     a send-all under a NONE group.
 *   - `collectAudienceReferences` (references.ts) keeps a deleted cycle visible
 *     in the builder's picker. A field missing here re-opens #82: the stored
 *     value filters forever and nobody can see or remove it.
 *   - `getFieldOptions` (audience-builder.tsx) points the checkbox list at the
 *     cycle source. A field missing here renders "No options available", so a
 *     value can never be picked at all.
 *
 * It lives in this module rather than beside the field registry because
 * person-fields.ts reaches prisma through its count loaders and so cannot be
 * imported for a runtime value by the client builder. This file already is the
 * shared client/server vocabulary (VALUELESS_OPS and NEGATIVE_OPS are here for
 * the same reason), and "what does this condition's value MEAN" is exactly what
 * it describes.
 */
export const CYCLE_VALUED_FIELD_KEYS: string[] = [
  "appliedToCycle",
  "acceptedInCycle",
  "rejectedInCycle",
  "interviewInvitedInCycle",
  "withdrewFromCycle",
];

/** A single leaf condition on a field. */
export type AudienceCondition = {
  field: string;
  op: ConditionOp;
  value?: string | string[];
  /**
   * Optional term scope for roster-shaped fields (`role`, `department`). Term
   * ids; an empty or absent list means "the active term", which is exactly what
   * every stored audience meant before this field existed -- so legacy
   * `audienceJson` keeps its original meaning with no migration.
   *
   * The scope belongs on the CONDITION rather than on a separate "term" field so
   * that a role and its terms compile into ONE `memberships: { some: {...} }`
   * clause. Two separate conditions ANDed together would each get their own
   * `some`, which different membership rows could satisfy -- "Volunteer" from
   * this term and "SP26" from a director stint would wrongly match.
   */
  terms?: string[];
};

/**
 * A nested group: its own connective over child nodes (Airtable-style).
 *
 * NONE negates the whole subtree ("matches none of these"). It is offered only
 * on NESTED groups, never at the root: a root NONE is "everyone except ...",
 * which is a send-all wearing a disguise.
 */
export type AudienceGroup = {
  match: "ALL" | "ANY" | "NONE";
  children: AudienceNode[];
};

/** A node in the audience tree: either a leaf condition or a nested group. */
export type AudienceNode = AudienceCondition | AudienceGroup;

export type Audience = {
  recordType: AudienceRecordType;
  /** Root connective. NONE is deliberately not allowed here; see AudienceGroup. */
  match: "ALL" | "ANY";
  /**
   * Root-level children: conditions and/or nested groups. A legacy flat audience
   * (all conditions, no groups) parses unchanged, since a condition IS a node, so
   * no migration of the schema-less audienceJson column is needed.
   */
  conditions: AudienceNode[];
};

/**
 * The audience a campaign or scope starts with, and the safe fallback for an
 * unparseable stored audienceJson: an empty tree, which compiles to
 * match-nobody rather than to everyone. Shared as one constant rather than
 * hand-duplicated at each call site so the "fail closed" default can't drift
 * out of sync between them.
 */
export const EMPTY_AUDIENCE: Audience = {
  recordType: "PERSON",
  match: "ALL",
  conditions: [],
};

export function isAudienceGroup(node: AudienceNode): node is AudienceGroup {
  return (
    typeof (node as AudienceGroup).match === "string" &&
    Array.isArray((node as AudienceGroup).children)
  );
}

export function isAudienceCondition(node: AudienceNode): node is AudienceCondition {
  return typeof (node as AudienceCondition).field === "string";
}

/** Recursively validate a node: a condition (has a `field`) or a well-formed group. */
function isValidNode(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  if (typeof n.field === "string") return true; // leaf condition
  if (
    (n.match === "ALL" || n.match === "ANY" || n.match === "NONE") &&
    Array.isArray(n.children)
  ) {
    return (n.children as unknown[]).every(isValidNode); // nested group, recurse
  }
  return false;
}

/**
 * The deepest nesting a client-supplied audience tree may have.
 *
 * Ten is far past anything the builder can produce by hand and far short of
 * what a call stack minds. The deepest tree in the starters is two.
 */
export const MAX_AUDIENCE_DEPTH = 10;

/**
 * Whether a tree nests deeper than MAX_AUDIENCE_DEPTH, checked ITERATIVELY.
 *
 * Guards the recursive walks that come after it. isAudience and enumerateNodes
 * both recurse, and both run BEFORE any node budget applies, so a tree nested
 * tens of thousands deep is a stack overflow rather than a rejection or a slow
 * query. The only way in is an authenticated sender posting a hand-built tree
 * to their own campaign's count action, so the damage is a 500 they caused
 * themselves, but the check is a few lines and the crash is unbounded.
 *
 * An explicit stack rather than recursion, or the guard would be the thing it
 * guards against. Reads `children`, which is what a group nests under; the
 * root's own `conditions` array is level one.
 */
export function exceedsAudienceDepth(v: unknown, max = MAX_AUDIENCE_DEPTH): boolean {
  const root = (v as { conditions?: unknown[] } | null)?.conditions;
  const stack: { node: unknown; depth: number }[] = Array.isArray(root)
    ? root.map((node) => ({ node, depth: 1 }))
    : [];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > max) return true;
    const children = (node as { children?: unknown[] } | null)?.children;
    if (Array.isArray(children)) {
      for (const child of children) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return false;
}

export function isAudience(v: unknown): v is Audience {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  if (a.recordType !== "PERSON") return false;
  if (a.match !== "ALL" && a.match !== "ANY") return false;
  if (!Array.isArray(a.conditions)) return false;
  return a.conditions.every(isValidNode);
}

/**
 * Loads a count per person for a count-kind field. Every loader MUST return an
 * entry for every ACTIVE-status person, defaulting to 0, so that "fewer than N"
 * includes people with no rows at all. See countWhere in operators.ts.
 *
 * Defined here (not in person-fields.ts, where COUNT_LOADERS and countField
 * live) so that person-fields.ts and the per-field loader modules that register
 * into COUNT_LOADERS can both import the type from one place without either
 * importing the other.
 *
 * `now`/`zone` are the SAME per-run clock and display zone every other
 * relative-date path in this codebase resolves through (see AudienceCtx in
 * person-fields.ts and dateWhere in operators.ts). A loader computing a
 * relative cutoff (e.g. "upcoming") MUST derive it from these, never from a
 * fresh `new Date()`: that would ignore the injected clock a recurring
 * campaign's tests and reruns depend on, and would compare by the SERVER's
 * UTC calendar day instead of the clinic's configured zone.
 */
export type CountLoader = (ctx: {
  activeTermId: string | null;
  now: Date;
  zone: DisplayTimeZone;
}) => Promise<Map<string, number>>;
