import type { TemplateSection } from "../types";
import { supplementQuestions } from "./supplements/volunteer";
import { normalizeDeptCode, SUPPLEMENT_DEPARTMENTS } from "./supplements/dept-codes";

export function volunteerSupplementSections(departments: string[]): TemplateSection[] {
  return departments
    .map((code) => normalizeDeptCode(code))
    .filter((norm) => SUPPLEMENT_DEPARTMENTS.VOLUNTEER.includes(norm))
    .map((norm) => ({
      title: `${norm} department questions`,
      order: 0,
      appliesTo: "NEW",
      departmentCode: norm,
      purpose: "APPLICATION",
      description: "Please limit each response to 250 words or less.",
      fields: (supplementQuestions[norm] ?? []).map((f, i) => ({ ...f, order: i })),
    }));
}
