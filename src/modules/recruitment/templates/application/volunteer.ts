import type { TemplateSection } from "../types";
import { supplementQuestions } from "./supplements/volunteer"; // Task 8 provides content; empty map until then
import { normalizeDeptCode } from "./supplements/dept-codes";

export function volunteerSupplementSections(departments: string[]): TemplateSection[] {
  return departments.map((code) => {
    const norm = normalizeDeptCode(code);
    return {
      title: `${norm} department questions`,
      order: 0,
      appliesTo: "NEW",
      departmentCode: norm,
      purpose: "APPLICATION",
      description: "Please limit each response to 250 words or less.",
      fields: (supplementQuestions[norm] ?? []).map((f, i) => ({ ...f, order: i })),
    };
  });
}
