import type { FieldCondition, FieldConditionOp } from "@/modules/recruitment/engine/field-visibility";

/** Seed a condition on the first available field. Returns undefined when there
 *  is nothing to key on, so the caller leaves the block unconditional. */
export function newCondition(fieldOptions: { value: string; label: string }[]): FieldCondition | undefined {
  const first = fieldOptions[0]?.value;
  return first ? { field: first, op: "is", value: "" } : undefined;
}

/** Switch a condition's operator, adding or dropping `value` to match the
 *  operator's shape so the result always satisfies parseFieldCondition. */
export function changeOp(cond: FieldCondition, op: FieldConditionOp): FieldCondition {
  if (op === "isAnswered") return { field: cond.field, op };
  const value = typeof cond.value === "string" ? cond.value : "";
  return { field: cond.field, op, value };
}
