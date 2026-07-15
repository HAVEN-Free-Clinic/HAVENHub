import type { WizardField } from "./wizard-steps";
import { isFieldVisible } from "@/modules/recruitment/engine/field-visibility";

/** A form value counts as present if it is a non-blank string, an array with at
 *  least one non-blank string, or boolean true. Used for required-field checks. */
export function isValuePresent(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some((v) => typeof v === "string" && v.trim() !== "");
  return false;
}

export function missingRequiredKeys(
  fields: Pick<WizardField, "key" | "required" | "type" | "visibleWhen">[],
  values: Record<string, unknown>,
): string[] {
  const answers = values as Record<string, string | string[] | undefined>;
  return fields
    .filter((f) => f.required && isFieldVisible(f.visibleWhen, answers) && !isValuePresent(values[f.key]))
    .map((f) => f.key);
}
