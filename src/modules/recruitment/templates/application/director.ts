import type { TemplateSection } from "../types";
import { supplementQuestions } from "./supplements/director";
import { normalizeDeptCode, SUPPLEMENT_DEPARTMENTS, defaultSupplementSectionTitle } from "./supplements/dept-codes";

export function directorSupplementSections(departments: string[]): TemplateSection[] {
  return departments
    .map((code) => normalizeDeptCode(code))
    .filter((norm) => SUPPLEMENT_DEPARTMENTS.DIRECTOR.includes(norm))
    .map((norm) => ({
      title: defaultSupplementSectionTitle(norm),
      order: 0,
      appliesTo: "NEW",
      departmentCode: norm,
      purpose: "APPLICATION",
      description: "These are optional. Answer any you'd like to share more about, and please keep each to 300 words.",
      // Optional on purpose: a place for directors to add anything extra, not a
      // requirement to finish the application.
      fields: (supplementQuestions[norm] ?? []).map((f, i) => ({ ...f, required: false, order: i })),
    }));
}
