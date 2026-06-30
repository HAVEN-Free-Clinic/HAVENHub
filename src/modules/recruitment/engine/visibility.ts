export type ApplicantType = "NEW" | "RENEWAL" | "TRANSFER";
export type ApplicantScope = "NEW" | "RENEWAL" | "BOTH";

export type SectionVisibilityInput = {
  id: string;
  appliesTo: ApplicantScope;
  departmentCode: string | null;
};

export type VisibilityContext = {
  applicantType: ApplicantType;
  selectedDepartmentCodes: string[];
};

/** A section shows iff its applicant-type scope matches AND (it is not a
 *  department supplement, or its department is among the chosen ones). */
export function isSectionVisible(
  section: SectionVisibilityInput,
  ctx: VisibilityContext
): boolean {
  const typeMatch = section.appliesTo === "BOTH" || section.appliesTo === ctx.applicantType;
  if (!typeMatch) return false;
  if (section.departmentCode === null) return true;
  return ctx.selectedDepartmentCodes.includes(section.departmentCode);
}

export function visibleSections<T extends SectionVisibilityInput>(
  sections: T[],
  ctx: VisibilityContext
): T[] {
  return sections.filter((section) => isSectionVisible(section, ctx));
}
