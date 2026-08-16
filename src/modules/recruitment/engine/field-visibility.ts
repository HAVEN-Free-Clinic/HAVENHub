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

/**
 * The answer, as the list of values it actually carries.
 *
 * Empty strings are dropped from an ARRAY answer, not just from a scalar one.
 * A group control posts one form value per sub-control under a single name --
 * SUBCOMMITTEE_RANK renders `rankCount` selects, all named for the field, and an
 * unranked slot posts "" -- so an untouched 3-rank question reaches the server as
 * ["", "", ""]. Treating that as three answers made "isAnswered" true on the
 * server while the browser, whose visibility map only gets an entry once a
 * control fires onChange, still had nothing for the key and read it as
 * unanswered. That is the client/server `visibleWhen` disagreement the 11th audit
 * closed for scalars, reopened by whichever field type happens to post empty
 * siblings: a dependent required field was hidden in the wizard and enforced at
 * submit, dead-ending the applicant on a question they were never shown.
 *
 * Normalizing HERE (rather than per field type at each call site) is the point:
 * the wizard, the submit path and the reviewer view all evaluate through this one
 * function, so no future group-shaped field type can drift again (audit 14).
 */
function asArray(a: string | string[] | undefined): string[] {
  if (a === undefined) return [];
  return (Array.isArray(a) ? a : [a]).filter((v) => v !== "");
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

/**
 * Normalize a raw answers map to the single representation every `visibleWhen`
 * evaluation must agree on, so the apply wizard, the submit path, and the
 * reviewer view can never disagree about whether a controller is "answered":
 *
 *   - string / string[]                       -> unchanged
 *   - boolean (a stored CHECKBOX answer)       -> "on" (true) / "" (false)
 *   - a stored file / signature ref (object     -> "attached"
 *     carrying `storedName`)
 *
 * The apply wizard already writes "on" for checkboxes and "attached" for files
 * into its own answer map; this brings the server-submit and review-time maps
 * into line. Values that cannot match a string condition (numbers, other
 * objects) are dropped, exactly as they were before.
 *
 * `presentFileKeys` marks keys whose file lives OUT of the answers map (at
 * submit time, uploads arrive as separate FormData File entries, not answers):
 * each is set to "attached" so a condition keyed on a FILE field evaluates the
 * same server-side as it rendered client-side.
 */
export function answersForConditions(
  answers: Record<string, unknown>,
  presentFileKeys?: Iterable<string>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(answers)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v as string[];
    else if (typeof v === "boolean") out[k] = v ? "on" : "";
    else if (v && typeof v === "object" && "storedName" in (v as object)) out[k] = "attached";
  }
  if (presentFileKeys) for (const k of presentFileKeys) out[k] = "attached";
  return out;
}
