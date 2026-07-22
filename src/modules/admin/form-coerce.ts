/** Form-field coercion helpers shared by admin pages. */
import type { EpicRequirement } from "@prisma/client";

/** An optional number input: empty/absent → null, otherwise parsed (validated downstream). */
export function optionalInt(raw: FormDataEntryValue | null): number | null {
  if (raw === null || String(raw).trim() === "") return null;
  return Number(raw);
}

// The `satisfies Record<EpicRequirement, true>` makes adding a fourth enum
// member fail compilation here until this map is updated, mirroring the
// assertNever guard in contract/epic-requirement.ts.
const EPIC_REQUIREMENTS = { ALL: true, SOME: true, NONE: true } as const satisfies Record<EpicRequirement, true>;

/** Coerce a form value to an EpicRequirement. Unknown/absent falls back to NONE
 *  so a crafted post can never over-provision Epic (the Select only submits the
 *  three uppercase enum values). */
export function epicRequirement(raw: FormDataEntryValue | null): EpicRequirement {
  const v = String(raw ?? "");
  return v in EPIC_REQUIREMENTS ? (v as EpicRequirement) : "NONE";
}
