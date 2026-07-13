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
  | "isFalse";

/** A single leaf condition on a field. */
export type AudienceCondition = {
  field: string;
  op: ConditionOp;
  value?: string | string[];
};

/** A nested group: its own ALL/ANY connective over child nodes (Airtable-style). */
export type AudienceGroup = {
  match: "ALL" | "ANY";
  children: AudienceNode[];
};

/** A node in the audience tree: either a leaf condition or a nested group. */
export type AudienceNode = AudienceCondition | AudienceGroup;

export type Audience = {
  recordType: AudienceRecordType;
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
  if ((n.match === "ALL" || n.match === "ANY") && Array.isArray(n.children)) {
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
