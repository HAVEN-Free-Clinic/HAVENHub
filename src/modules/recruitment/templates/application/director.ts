import type { TemplateSection } from "../types";
import { supplementQuestions } from "./supplements/director";
import { normalizeDeptCode, SUPPLEMENT_DEPARTMENTS } from "./supplements/dept-codes";

export function directorSupplementSections(departments: string[]): TemplateSection[] {
  return departments
    .map((code) => normalizeDeptCode(code))
    .filter((norm) => SUPPLEMENT_DEPARTMENTS.DIRECTOR.includes(norm))
    .map((norm) => ({
      title: `${norm} department questions`,
      order: 0,
      appliesTo: "NEW",
      departmentCode: norm,
      purpose: "APPLICATION",
      description: "Please limit each response to 300 words.",
      fields: (supplementQuestions[norm] ?? []).map((f, i) => ({ ...f, order: i })),
    }));
}
