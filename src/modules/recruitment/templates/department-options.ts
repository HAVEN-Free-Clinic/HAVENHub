import type { TemplateOption } from "./types";

export type DepartmentNameRow = { code: string; name: string };

/**
 * Resolve a cycle's department codes to display options for a DEPARTMENT_CHOICE
 * field, in the cycle's own order (not alphabetical) so a director's ordering
 * survives. A code with no matching Department row -- an alias or a department
 * that has since been deleted -- keeps the code as its own label rather than
 * disappearing from the list, so it stays selectable and submittable exactly
 * as it was before this resolution existed.
 */
export function departmentChoiceOptions(codes: string[], departments: DepartmentNameRow[]): TemplateOption[] {
  const nameByCode = new Map(departments.map((d) => [d.code, d.name]));
  return codes.map((code) => ({ value: code, label: nameByCode.get(code) ?? code }));
}
