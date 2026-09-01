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
  // Ordered comparison, used by year-kind fields (see gradYear).
  | "lt"
  | "gt"
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

export function isAudience(v: unknown): v is Audience {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  if (a.recordType !== "PERSON") return false;
  if (a.match !== "ALL" && a.match !== "ANY") return false;
  if (!Array.isArray(a.conditions)) return false;
  return a.conditions.every(isValidNode);
}
