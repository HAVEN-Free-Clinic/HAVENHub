export type AudienceRecordType = "PERSON"; // extensible: future "APPLICANT"
export type ConditionOp = "eq" | "in" | "isTrue" | "isFalse";

export type AudienceCondition = {
  field: string;
  op: ConditionOp;
  value?: string | string[];
};

export type Audience = {
  recordType: AudienceRecordType;
  match: "ALL" | "ANY";
  conditions: AudienceCondition[];
};

export function isAudience(v: unknown): v is Audience {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  if (a.recordType !== "PERSON") return false;
  if (a.match !== "ALL" && a.match !== "ANY") return false;
  if (!Array.isArray(a.conditions)) return false;
  return a.conditions.every(
    (c) => c && typeof c === "object" && typeof (c as AudienceCondition).field === "string",
  );
}
