/**
 * Dual roles: the auxiliary departments a volunteer can offer to serve in
 * ALONGSIDE the department they are accepted into.
 *
 * A dual role is deliberately NOT a second acceptance. Two acceptances on one
 * application is an error state (see engine/conflicts.ts, which blocks
 * onboarding and promotion until a recruitment lead resolves it): two
 * departments each believing they won the same person. A dual role is the
 * opposite -- one primary department plus a standing offer to help another --
 * so it travels its own path and never touches the conflict guard.
 *
 * Both dual departments gate on something the form cannot check. VADM needs a
 * licence to administer vaccines; INTP needs a language assessment, which its
 * own help text promises. So checking the box records an INTEREST, and the
 * receiving department's directors decide. Nothing here ever puts somebody on a
 * roster on its own.
 */

/**
 * Application field key -> the department code that interest belongs to.
 *
 * The keys are the STANDARD, locked keys the application template writes
 * (see templates/field-groups.ts, additionalOpportunitiesSection). Matching on
 * a constant rather than a literal at each use site is the same guard
 * LANGUAGES_FIELD_KEY provides: a form field can be deleted and re-added
 * through the builder, and a re-added field derives its key from its label, so
 * a use site spelling the key inline would silently stop matching.
 *
 * Adding a third dual department is one entry here plus one field in
 * additionalOpportunitiesSection. It is intentionally NOT a Department table
 * toggle: each question's help text states that department's own eligibility
 * bar in its own words (a CT RN licence for VADM, fluency for INTP), and a
 * generated question would lose the part that makes it answerable.
 */
export const DUAL_ROLE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  vadm_dual_option: "VADM",
  intp_dual_option: "INTP",
});

/** Every department code that can be offered as a dual role. */
export const DUAL_ROLE_DEPARTMENT_CODES: readonly string[] = Object.freeze(
  [...new Set(Object.values(DUAL_ROLE_FIELDS))].sort(),
);

export function isDualRoleDepartment(code: string): boolean {
  return DUAL_ROLE_DEPARTMENT_CODES.includes(code);
}

/**
 * A stored CHECKBOX answer is truthy.
 *
 * Both spellings are accepted on purpose. The wizard submits the browser's
 * "on", and answersForConditions normalizes a stored boolean to "on"/"", so
 * `answers` in the wild holds `true` for some rows and `"on"` for others
 * depending on which path wrote them. Anything else -- "", false, null, an
 * absent key -- is unchecked.
 */
export function isChecked(value: unknown): boolean {
  return value === true || value === "on";
}

/**
 * The dual-role department codes an application declared, read from its raw
 * answers.
 *
 * Used at SUBMIT to hoist the codes onto Application.dualRoleDepartments (the
 * same reason languagesClaimed is hoisted: promotion should read a typed column
 * rather than re-parse a JSON blob), and by the migration backfill for
 * applications submitted before that column existed.
 *
 * Sorted and de-duplicated so the stored array has one canonical form and two
 * submissions of the same answers cannot differ.
 */
export function dualRoleDepartmentsFromAnswers(answers: unknown): string[] {
  if (!answers || typeof answers !== "object") return [];
  const record = answers as Record<string, unknown>;
  const codes = new Set<string>();
  for (const [key, code] of Object.entries(DUAL_ROLE_FIELDS)) {
    if (isChecked(record[key])) codes.add(code);
  }
  return [...codes].sort();
}

/**
 * The dual departments to actually record an interest in, given what the
 * applicant asked for and where they ended up.
 *
 * Two exclusions, both of which would otherwise create a row that can never be
 * actioned:
 *
 *  - the primary department. Someone routed to VADM who also ticked the VADM
 *    box is already a VADM volunteer; an interest row would ask VADM's director
 *    to add somebody they can already see on their roster.
 *  - a department they already hold an ACTIVE membership in. A returning member
 *    re-stating a dual role they were granted last term is not new work.
 *
 * Pure, so both rules are stated once and testable without a database.
 */
export function dualRolesToRecord(input: {
  declared: readonly string[];
  primaryDepartmentCode: string;
  activeDepartmentCodes: readonly string[];
}): string[] {
  const held = new Set([input.primaryDepartmentCode, ...input.activeDepartmentCodes]);
  return [...new Set(input.declared)]
    .filter((code) => isDualRoleDepartment(code) && !held.has(code))
    .sort();
}
