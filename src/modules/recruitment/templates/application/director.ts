import type { TemplateSection } from "../types";
import { supplementQuestions } from "./supplements/director";
import { normalizeDeptCode } from "./supplements/dept-codes";

export function directorSupplementSections(departments: string[]): TemplateSection[] {
  return departments.map((code) => {
    const norm = normalizeDeptCode(code);
    return {
      title: `${norm} department questions`,
      order: 0,
      appliesTo: "NEW",
      departmentCode: norm,
      purpose: "APPLICATION",
      fields: (supplementQuestions[norm] ?? []).map((f, i) => ({ ...f, order: i })),
    };
  });
}
