import type { TemplateOption } from "./types";
import { defaultSupplementSectionTitle } from "./application/supplements/dept-codes";

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

export type TitledSection = { title: string; departmentCode: string | null };

/**
 * A department supplement section's stored FormSection.title is written once,
 * at cycle creation, by volunteer.ts / director.ts (materialize.ts:7 persists
 * it verbatim), so every already-created cycle -- including any currently
 * open one -- has the code baked into its title text. Editing the template
 * only changes cycles created afterward, so the department name is instead
 * swapped in here, at render time, for every cycle uniformly.
 *
 * The swap only happens when the stored title still equals the generated
 * default for that section's departmentCode, built from
 * defaultSupplementSectionTitle -- the exact same expression volunteer.ts
 * and director.ts call to produce the title in the first place, imported
 * here rather than re-typed, so the generator and this matcher cannot drift
 * apart silently. A title a director customized therefore never matches and
 * is returned untouched, and a section with no departmentCode (the shared,
 * non-supplement sections) is returned untouched too.
 *
 * A departmentCode with no matching Department row (an alias, or a
 * department deleted after the section was created) falls back to the
 * stored title rather than rendering a broken "undefined department
 * questions".
 */
export function resolveSectionTitle(section: TitledSection, departments: DepartmentNameRow[]): string {
  if (!section.departmentCode) return section.title;
  if (section.title !== defaultSupplementSectionTitle(section.departmentCode)) return section.title;
  const dept = departments.find((d) => d.code === section.departmentCode);
  return dept ? `${dept.name} department questions` : section.title;
}
