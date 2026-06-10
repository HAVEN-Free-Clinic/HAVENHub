/** Form-field coercion helpers shared by admin pages. */

/** An optional number input: empty/absent → null, otherwise parsed (validated downstream). */
export function optionalInt(raw: FormDataEntryValue | null): number | null {
  if (raw === null || String(raw).trim() === "") return null;
  return Number(raw);
}
