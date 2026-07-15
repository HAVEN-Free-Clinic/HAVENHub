export type FieldConditionOp = "is" | "isNot" | "isAnyOf" | "isAnswered";
export type FieldCondition = { field: string; op: FieldConditionOp; value?: string | string[] };

export function parseFieldCondition(v: unknown): FieldCondition | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const field = o.field;
  const op = o.op;
  if (typeof field !== "string" || !field) return null;
  if (op === "isAnswered") return { field, op };
  if (op === "is" || op === "isNot") {
    return typeof o.value === "string" ? { field, op, value: o.value } : null;
  }
  if (op === "isAnyOf") {
    return Array.isArray(o.value) && o.value.every((x) => typeof x === "string")
      ? { field, op, value: o.value as string[] }
      : null;
  }
  return null;
}
