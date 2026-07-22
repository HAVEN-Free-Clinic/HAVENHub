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

/** Apply a raw text-input value to a condition, keeping `value`'s shape in
 *  sync with `op` so the result always satisfies parseFieldCondition. This is
 *  the one place a condition's `value` is written from a plain string input,
 *  so it is also what keeps a pre-existing `isAnyOf` condition (value is a
 *  string array) from being corrupted into a string by an editor that only
 *  ever displays a single text field. Does not mutate `cond`. */
export function changeValue(cond: FieldCondition, raw: string): FieldCondition {
  if (cond.op === "isAnswered") return cond;
  if (cond.op === "isAnyOf") {
    return { ...cond, value: raw.split(",").map((s) => s.trim()).filter(Boolean) };
  }
  return { ...cond, value: raw };
}
