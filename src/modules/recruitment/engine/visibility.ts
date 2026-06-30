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

/** A department TRANSFER answers the same questions as a new applicant, so for
 *  section visibility it is scoped to NEW. NEW and RENEWAL map to themselves. */
export function scopeForApplicantType(type: ApplicantType): Exclude<ApplicantScope, "BOTH"> {
  return type === "TRANSFER" ? "NEW" : type;
}

/** Human label for an applicant type, used in review screens. */
export function applicantTypeLabel(type: ApplicantType): string {
  return type === "RENEWAL" ? "Renewal" : type === "TRANSFER" ? "Transfer" : "New";
}

/** A section shows iff its applicant-type scope matches AND (it is not a
 *  department supplement, or its department is among the chosen ones). */
export function isSectionVisible(
  section: SectionVisibilityInput,
  ctx: VisibilityContext
): boolean {
  const scope = scopeForApplicantType(ctx.applicantType);
  const typeMatch = section.appliesTo === "BOTH" || section.appliesTo === scope;
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
