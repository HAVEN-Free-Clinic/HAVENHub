import type { Track } from "@prisma/client";
import type { TemplateOption, TemplateSection } from "./types";
import {
  identitySection, eligibilitySection, languagesSection, additionalOpportunitiesSection,
  availabilitySection, volunteerDepartmentSection, volunteerApplicationMaterialsSection,
  acknowledgementsSection, additionalInfoSection,
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
       volunteerDepartmentSection(), volunteerApplicationMaterialsSection(), availabilitySection(availabilityDates), acknowledgementsSection(track), additionalInfoSection()]
    : [identitySection(), directorHavenExperienceSection(), languagesSection(), directorEssaysSection(),
       directorDepartmentSection(), availabilitySection(availabilityDates), subcommitteeSection(), directorLogisticsSection()];
  const supplements = getSupplementSections(track, departments);
  return renumber([...shared, ...supplements]);
}

/** Department supplement sections only (no shared/identity sections), gated to
 *  real supplement departments and normalized by the track-specific composer.
 *  Used both by getApplicationTemplate above and to sync a cycle's supplement
 *  sections when its department list changes after creation. */
export function getSupplementSections(track: Track, departments: string[]): TemplateSection[] {
  return track === "VOLUNTEER" ? volunteerSupplementSections(departments) : directorSupplementSections(departments);
}
