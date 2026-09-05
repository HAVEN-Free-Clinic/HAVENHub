import { isFieldVisible } from "./field-visibility";
import { isDisplayOnlyNotice } from "./notice";

/**
 * Which required questions a set of answers has not answered yet.
 *
 * This lived in the apply wizard, where it decided whether "Next" was allowed.
 * It moved here when the draft-reminder stream needed the same answer from a
 * cron with no page around it: "how much of this application is left?" has to
 * mean exactly what the form means by it, or the email tells an applicant they
 * still owe a question the wizard would let them past.
 */

/** The shape of a form field this module needs to judge required-ness. Kept
 *  structural rather than importing the wizard's WizardField, so the engine does
 *  not depend on a page's view model. */
export type RequirableField = {
  key: string;
  required: boolean;
  type: string;
  visibleWhen?: unknown;
  validation?: unknown;
};

/** A form value counts as present if it is a non-blank string, an array with at
 *  least one non-blank string, or boolean true. Used for required-field checks.
 *
 *  The blank-string case is load-bearing well beyond the wizard: the onboarding
 *  contract fields are pre-seeded as empty strings on every draft, so a key's
 *  mere presence in `answers` says nothing about whether it was filled in. Any
 *  progress measure that tests for the key rather than the value reports a
 *  completely untouched application as finished. */
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
  fields: RequirableField[],
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
