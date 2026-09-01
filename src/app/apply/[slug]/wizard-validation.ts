import type { WizardField } from "./wizard-steps";
import { isFieldVisible } from "@/modules/recruitment/engine/field-visibility";
import { isDisplayOnlyNotice } from "@/modules/recruitment/engine/notice";

/** A form value counts as present if it is a non-blank string, an array with at
 *  least one non-blank string, or boolean true. Used for required-field checks. */
export function isValuePresent(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some((v) => typeof v === "string" && v.trim() !== "");
  return false;
}

export function missingRequiredKeys(
  // `validation` is optional here (it is not on WizardField) purely so callers
  // that only care about the required-ness of plain questions need not thread it
  // through; a missing blob simply cannot be an acknowledging notice.
  fields: (Pick<WizardField, "key" | "required" | "type" | "visibleWhen"> & { validation?: unknown })[],
  values: Record<string, unknown>,
): string[] {
  const answers = values as Record<string, string | string[] | undefined>;
  return fields
    // A display-only NOTICE renders no control, so it can never be satisfied.
    // updateField already refuses to persist one as required; this is the second
    // guard, because the cost of the two disagreeing is an applicant stuck on
    // "answer the highlighted question" pointing at a paragraph of policy text.
    .filter((f) => !isDisplayOnlyNotice(f))
    .filter((f) => f.required && isFieldVisible(f.visibleWhen, answers) && !isValuePresent(values[f.key]))
    .map((f) => f.key);
}
