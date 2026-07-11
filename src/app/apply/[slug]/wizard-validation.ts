import type { WizardField } from "./wizard-steps";

/** A form value counts as present if it is a non-blank string, an array with at
 *  least one non-blank string, or boolean true. Used for required-field checks. */
export function isValuePresent(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some((v) => typeof v === "string" && v.trim() !== "");
  return false;
}

export function missingRequiredKeys(
  fields: Pick<WizardField, "key" | "required" | "type">[],
  values: Record<string, unknown>,
): string[] {
  return fields.filter((f) => f.required && !isValuePresent(values[f.key])).map((f) => f.key);
}
