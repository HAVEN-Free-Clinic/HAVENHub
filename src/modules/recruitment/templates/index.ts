import type { Track } from "@prisma/client";
import type { TemplateOption, TemplateSection } from "./types";
import {
  identitySection, eligibilitySection, languagesSection, additionalOpportunitiesSection,
  availabilitySection, volunteerDepartmentSection, acknowledgementsSection, additionalInfoSection,
  directorHavenExperienceSection, directorEssaysSection, directorDepartmentSection,
  subcommitteeSection, directorLogisticsSection,
} from "./field-groups";
import { volunteerSupplementSections } from "./application/volunteer";
import { directorSupplementSections } from "./application/director";

export type { TemplateOption, TemplateSection } from "./types";

/** Renumber section.order and every field.order to be globally sequential. */
function renumber(sections: TemplateSection[]): TemplateSection[] {
  return sections.map((s, i) => ({ ...s, order: i, fields: s.fields.map((f, j) => ({ ...f, order: j })) }));
}

export function getApplicationTemplate(track: Track, departments: string[], availabilityDates: TemplateOption[]): TemplateSection[] {
  const shared: TemplateSection[] = track === "VOLUNTEER"
    ? [identitySection(), eligibilitySection(), languagesSection(), additionalOpportunitiesSection(),
       volunteerDepartmentSection(), availabilitySection(availabilityDates), acknowledgementsSection(track), additionalInfoSection()]
    : [identitySection(), directorHavenExperienceSection(), languagesSection(), directorEssaysSection(),
       directorDepartmentSection(), availabilitySection(availabilityDates), subcommitteeSection(), directorLogisticsSection()];
  const supplements = track === "VOLUNTEER" ? volunteerSupplementSections(departments) : directorSupplementSections(departments);
  return renumber([...shared, ...supplements]);
}
