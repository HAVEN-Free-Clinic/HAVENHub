import type { Track } from "@prisma/client";

// Airtable used a few codes that differ from the repo Department seed, and
// three departments have since been recoded (PHAM -> MEDS and LABR -> PHLO on
// 2026-08-25, ORHI -> ORHL on 2026-08-29), so legacy form data still spells
// them the old way.
const ALIASES: Record<string, string> = { FCLR: "FCRL", "SR&R": "SRR", PHAM: "MEDS", LABR: "PHLO", ORHI: "ORHL" };

export function normalizeDeptCode(code: string): string {
  const c = code.trim().toUpperCase();
  return ALIASES[c] ?? c;
}

/**
 * The generated title for a department supplement section, built from the
 * normalized code alone (no Department table lookup at template time -- see
 * department-options.ts for why the display name is swapped in at render
 * time instead). volunteer.ts and director.ts call this rather than
 * inlining the literal so there is exactly one expression to keep in sync
 * with department-options.ts's resolveSectionTitle, which imports this same
 * function to know what "still the generated default" means.
 */
export function defaultSupplementSectionTitle(code: string): string {
  return `${code} department questions`;
}

// Canonical (normalized) department codes that carry a supplement section,
// extracted verbatim from the live Airtable application forms.
export const SUPPLEMENT_DEPARTMENTS: Record<Track, string[]> = {
  VOLUNTEER: ["CCRH", "EDUC", "JCTP", "JCTS", "MDIC", "ORHL", "PATS", "PHLO", "QAQI", "SCTP", "SCTS"],
  DIRECTOR: [
    "EXEC", "JONES", "EDUC", "ICDD", "MDIC", "PCAR", "ITCM", "PHLO", "ORHL", "QAQI",
    "REFF", "SOSE", "SRHD", "VADM", "FIND", "INTP", "MEDS", "SRR",
  ],
};
