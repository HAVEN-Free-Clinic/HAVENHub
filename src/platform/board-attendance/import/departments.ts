/**
 * Mapping the board sheet's department column to a Department code.
 *
 * The sheet writes departments the way the board says them out loud ("LCC",
 * "Lab", "Pharmacy", "Clinical Advisor"), and several of those names have since
 * been renamed in the hub. The mapping is therefore explicit and total: an
 * unrecognized label resolves to null and is reported, never coerced.
 *
 * That matters more here than it looks. The department decides which
 * TermMembership the import writes, and a membership is the row that says "this
 * person directed this department in this term". Filing a director under the
 * wrong department misstates the institutional record the import exists to
 * preserve.
 */

/**
 * Sheet label (lowercased, punctuation-insensitive) -> Department.code.
 *
 * The four renames below are the same ones platform/airtable/import/history
 * already carries as code aliases, confirmed by ops on 2026-08-05 and
 * 2026-08-25: Pharmacy is now Medication Access (MEDS), Lab is Phlebotomy
 * (PHLO), the TB work sits under Infectious and Chronic Disease (ICDD), and LCC
 * is Patient Navigation: Longitudinal Care (PNLC). The 2026 sheet corroborates
 * the LTBI one directly: the row that read "LTBI" in 2025 reads "ICDD" in 2026
 * with the same directors under it.
 */
const LABELS: Record<string, string> = {
  "behavioral health": "BVHD",
  "behavioral health department": "BVHD",
  "clinical advisor": "PCAR",
  "community relations advocacy": "CRAD",
  "community relations and advocacy": "CRAD",
  education: "EDUC",
  "executive director": "EXEC",
  "faculty relations": "FCRL",
  "finance and development": "FIND",
  "food pharmacy": "FOOD",
  icdd: "ICDD",
  ltbi: "ICDD",
  "it communications": "ITCM",
  "interpretation diversity": "INTP",
  lcc: "PNLC",
  lab: "PHLO",
  "medical debt insurance counseling": "MDIC",
  "medical legal partnership": "MDLP",
  "oral health": "ORHL",
  "oral health initiative": "ORHL",
  "patient services": "PATS",
  pharmacy: "MEDS",
  "public relations": "PBRL",
  "qa qi": "QAQI",
  referrals: "REFF",
  "reproductive health": "SRHD",
  "reproductive health department": "SRHD",
  "social services": "SOSE",
  "student recruitment": "SRR",
  vaccine: "VADC",
};

/** Lowercased, with "&", "/", and hyphens flattened to spaces. */
function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * The Department code for a sheet label, or null when the label is not one this
 * table knows. `knownCodes` is the set of codes that actually exist, so a
 * mapping whose target was since deleted reports as unmapped rather than
 * writing a dangling code.
 */
export function resolveBoardDepartmentCode(
  label: string | null | undefined,
  knownCodes: Set<string>,
): string | null {
  const normalized = normalizeLabel(label ?? "");
  if (normalized === "") return null;
  const code = LABELS[normalized];
  if (!code) return null;
  return knownCodes.has(code) ? code : null;
}
