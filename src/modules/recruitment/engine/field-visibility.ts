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

function asArray(a: string | string[] | undefined): string[] {
  if (a === undefined) return [];
  return Array.isArray(a) ? a : a === "" ? [] : [a];
}

export function isFieldVisible(
  visibleWhen: unknown,
  answers: Record<string, string | string[] | undefined>,
): boolean {
  const cond = parseFieldCondition(visibleWhen);
  if (!cond) return true; // no/invalid condition -> always visible
  const ans = asArray(answers[cond.field]);
  switch (cond.op) {
    case "isAnswered": return ans.length > 0;
    case "is": return ans.includes(cond.value as string);
    case "isNot": return !ans.includes(cond.value as string);
    case "isAnyOf": return (cond.value as string[]).some((v) => ans.includes(v));
    default: return true;
  }
}

/** Filter a field list to the visible ones given the current answers. */
export function visibleFields<T extends { visibleWhen?: unknown }>(
  fields: T[],
  answers: Record<string, string | string[] | undefined>,
): T[] {
  return fields.filter((f) => isFieldVisible(f.visibleWhen, answers));
}

/**
 * Merges an `answers` map with the authoritative department selection under
 * the department-choice field's key, so a `visibleWhen` condition keyed on
 * that field sees the current department regardless of how the applicant
 * navigated there. `answers[departmentChoiceKey]` alone can go stale:
 * interacting with the DEPARTMENT_CHOICE control's own onChange updates it,
 * but switching applicantType (chooseType) or rendering a single-department
 * RENEWAL's read-only field (no onChange at all) do not. The caller's
 * `selectedDepartmentCodes` is already the authoritative selection for every
 * navigation path, so it always wins here, overriding any stale/absent
 * `answers` entry for that key. Returns a new object; does not mutate
 * `answers`.
 */
export function mergeDepartmentAnswer(
  answers: Record<string, string | string[]>,
  departmentChoiceKey: string | undefined,
  selectedDepartmentCodes: string[],
): Record<string, string | string[]> {
  return { ...answers, ...(departmentChoiceKey ? { [departmentChoiceKey]: selectedDepartmentCodes } : {}) };
}
