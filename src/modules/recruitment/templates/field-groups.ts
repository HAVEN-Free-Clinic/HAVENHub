import type { Track } from "@prisma/client";
import type { TemplateOption, TemplateSection } from "./types";
import { YALE_AFFILIATION, GRAD_YEAR, SPANISH_PROFICIENCY, MEDICAL_CERTIFICATIONS, YES_NO } from "./content/options";
import { VOLUNTEER_AGREEMENT, PROFESSIONALISM_POLICY, TRAINING_ACKNOWLEDGEMENT } from "./content/acknowledgements";

const sec = (
  title: string,
  appliesTo: TemplateSection["appliesTo"],
  fields: Array<Omit<TemplateSection["fields"][number], "order">>,
  extra: Partial<Pick<TemplateSection, "description" | "departmentCode" | "purpose">> = {},
): TemplateSection => ({
  title,
  order: 0,
  appliesTo,
  departmentCode: extra.departmentCode ?? null,
  purpose: extra.purpose ?? "APPLICATION",
  description: extra.description,
  fields: fields.map((f, i) => ({ ...f, order: i })),
});

export function identitySection(): TemplateSection {
  return sec("Personal details", "NEW", [
    { key: "first_name", label: "First name", type: "SHORT_TEXT", required: true },
    { key: "last_name", label: "Last name", type: "SHORT_TEXT", required: true },
    { key: "pronouns", label: "Pronouns", type: "SHORT_TEXT", required: false },
    { key: "net_id", label: "Yale NetID", type: "SHORT_TEXT", required: true },
    { key: "email", label: "Yale email", type: "EMAIL", required: true },
    { key: "phone", label: "Phone number", type: "PHONE", required: false },
    { key: "yale_affiliation", label: "Yale affiliation", type: "SINGLE_SELECT", required: true, options: YALE_AFFILIATION },
    { key: "yale_affiliation_other", label: "If other or staff, please specify your school/title and department", type: "SHORT_TEXT", required: false,
      visibleWhen: { field: "yale_affiliation", op: "isAnyOf", value: ["other_yale", "staff"] } },
    { key: "grad_year", label: "Graduation year", type: "SINGLE_SELECT", required: true, options: GRAD_YEAR },
  ], { description: "If you are a returning volunteer, your record is pulled automatically and you can skip this section." });
}

export function eligibilitySection(): TemplateSection {
  return sec("Medical and language experience", "NEW", [
    { key: "licensed_professional", label: "Are you a licensed medical professional? (Including EMT)", type: "SINGLE_SELECT", required: true, options: YES_NO },
    { key: "medical_certifications", label: "If you hold active certifications/licenses, please select all that apply", type: "MULTI_SELECT", required: false, options: MEDICAL_CERTIFICATIONS,
      visibleWhen: { field: "licensed_professional", op: "is", value: "yes" } },
    { key: "medical_details", label: "Medical professional details", type: "SHORT_TEXT", required: false,
      visibleWhen: { field: "licensed_professional", op: "is", value: "yes" } },
  ]);
}

export function languagesSection(): TemplateSection {
  return sec("Languages", "NEW", [
    { key: "spanish_proficiency", label: "Spanish proficiency level", type: "SINGLE_SELECT", required: true, options: SPANISH_PROFICIENCY,
      helpText: "If you wish to speak Spanish at HAVEN (regardless of role) you must pass an assessment with the Department of Interpretation and Diversity. Everyone selecting Conversational or above will be invited to this assessment." },
    { key: "other_languages", label: "Do you speak other languages?", type: "SINGLE_SELECT", required: true, options: YES_NO },
    { key: "other_languages_detail", label: "Which other languages do you speak?", type: "SHORT_TEXT", required: false,
      visibleWhen: { field: "other_languages", op: "is", value: "yes" } },
  ]);
}

export function additionalOpportunitiesSection(): TemplateSection {
  return sec("Additional volunteer opportunities", "NEW", [
    { key: "vadm_dual_option", label: "VADM dual option", type: "CHECKBOX", required: false,
      helpText: "If you are a licensed RN in CT (or otherwise hold a valid U.S. license to administer vaccines, or are willing to become CT-licensed) and are willing to administer vaccines on weekends when not scheduled with your department, check this box." },
    { key: "intp_dual_option", label: "INTP dual option", type: "CHECKBOX", required: false,
      helpText: "If you are fluent in a language other than English and would be comfortable serving on-call as an interpreter, check this box and tell us what language you speak. We will contact you to assess your proficiency." },
  ]);
}

export function availabilitySection(dates: TemplateOption[]): TemplateSection {
  return sec("Availability", "BOTH", [
    { key: "availability", label: "Please indicate all clinic dates you are available to volunteer", type: "MULTI_SELECT", required: true, options: dates,
      helpText: "To be eligible you must commit to a minimum of four shifts. If you are applying for a non-patient-facing role, select the weeks you are available to commit to HAVEN." },
  ]);
}

/** Scoped NEW so the department choice (and its "are you flexible?" follow-up)
 *  is asked of new applicants and department-switchers (TRANSFER resolves to NEW)
 *  yet hidden from same-department renewals, who keep the department they pick in
 *  the intro step. The willingness-to-switch question is asked of renewals too, so
 *  it lives in its own BOTH-scoped section (volunteerDepartmentSwitchSection)
 *  rather than here -- applicant scope is per-section, not per-field. */
export function volunteerDepartmentSection(): TemplateSection {
  return sec("Department preference", "NEW", [
    { key: "department_choice", label: "Department / position preference", type: "DEPARTMENT_CHOICE", required: true },
    { key: "department_flexibility", label: "Are you flexible in your department choice?", type: "SINGLE_SELECT", required: false, options: YES_NO },
  ], { description: "See department descriptions at havenfreeclinic.com/apply." });
}

/** Asked of everyone, including renewals: a renewal keeps their current
 *  department but may still be willing to move. Kept out of the NEW-scoped
 *  volunteerDepartmentSection so it survives for renewals. */
export function volunteerDepartmentSwitchSection(): TemplateSection {
  return sec("Switching departments", "BOTH", [
    { key: "switch_departments", label: "Would you be willing to switch departments?", type: "SINGLE_SELECT", required: false, options: YES_NO },
  ]);
}

/** Cover letter + resume, required, but scoped NEW so they are asked of new
 *  applicants and department-switchers (TRANSFER resolves to NEW) yet hidden from
 *  same-department renewals -- matching the fields' own help text. Kept as its own
 *  section because required-ness is per-field but applicant scope is per-section;
 *  leaving these required FILE fields in the BOTH "Department preference" section
 *  hard-blocked every renewal at submit ("A required file is missing"). */
export function volunteerApplicationMaterialsSection(): TemplateSection {
  return sec("Application materials", "NEW", [
    { key: "cover_letter", label: "Cover letter", type: "FILE", required: true,
      helpText: "We request that all new incoming volunteers or if you want to switch departments please submit a PDF cover letter." },
    { key: "resume", label: "Resume", type: "FILE", required: true, helpText: "Please upload your resume here." },
  ]);
}

export function directorHavenExperienceSection(): TemplateSection {
  return sec("HAVEN experience", "BOTH", [
    { key: "prev_volunteered", label: "Have you previously volunteered at HAVEN?", type: "SINGLE_SELECT", required: true, options: YES_NO },
    { key: "returning_board", label: "Have you previously been on the Board at the HFC?", type: "SINGLE_SELECT", required: true,
      options: [
        { value: "yes_term_extension", label: "Yes - Term Extension" },
        { value: "yes_new_position", label: "Yes - New Position" },
        { value: "no", label: "No" },
      ] },
  ]);
}

export function directorEssaysSection(): TemplateSection {
  return sec("Short answer questions", "BOTH", [
    { key: "essay_community_care", label:
        "Share a story or experience that influenced your commitment to community-centered care. How does this connect to why you want to lead at HAVEN, and how would that experience inform your leadership?",
      type: "LONG_TEXT", required: true, helpText: "Please limit response to 300 words.", validation: { wordLimit: 300 } },
    { key: "essay_priorities", label: "What do you believe should be important priorities for a student-run free clinic?",
      type: "LONG_TEXT", required: true, helpText: "Please limit response to 300 words.", validation: { wordLimit: 300 } },
    { key: "essay_accountability", label:
        "Directors must regularly hold volunteers and peers accountable. Describe a time you had to give direct feedback or enforce a policy. How did you approach it, and what did you learn from the experience?",
      type: "LONG_TEXT", required: true, helpText: "Please limit response to 300 words.", validation: { wordLimit: 300 } },
  ]);
}

/** Scoped NEW, mirroring the volunteer department section: a renewing director
 *  keeps their current department (chosen in the intro step), so the ranked-
 *  preference dropdown is asked only of new applicants and transfers (TRANSFER
 *  resolves to NEW), not same-department renewals. */
export function directorDepartmentSection(): TemplateSection {
  return sec("Department preferences", "NEW", [
    { key: "department_choice", label: "Department preference (1st and 2nd choice)", type: "DEPARTMENT_CHOICE", required: true,
      helpText: "See department descriptions at havenfreeclinic.com/apply before ranking your choices." },
  ]);
}

export function subcommitteeSection(): TemplateSection {
  return sec("Subcommittee preference", "BOTH", [
    { key: "subcommittee_rank", label: "Rank your subcommittee preferences", type: "SUBCOMMITTEE_RANK", required: true,
      helpText: "Directors also serve on one of HAVEN's subcommittees (CQA, CREC, or S&D). Rank your subcommittee preferences from most to least preferred." },
  ]);
}

export function directorLogisticsSection(): TemplateSection {
  return sec("Logistics", "BOTH", [
    { key: "time_commitments", label: "What other significant time commitments do you have or anticipate having next year?", type: "LONG_TEXT", required: true },
    { key: "resume", label: "Please upload your most recent CV/Resume", type: "FILE", required: true },
    { key: "additional_info", label: "Additional information", type: "LONG_TEXT", required: false },
    // Info-session attendance is no longer self-attested on the application; it is
    // reconciled on the backend against the info-session attendance list.
  ]);
}

export function acknowledgementsSection(_track: Track): TemplateSection {
  // Volunteer bodies are captured verbatim; the director-track bodies are filled
  // during content authoring (Task 8) and default to the volunteer text until then.
  return sec("Volunteer contract", "BOTH", [
    { key: "volunteer_agreement", label: "Volunteer agreement", type: "SHORT_TEXT", required: true, helpText: VOLUNTEER_AGREEMENT },
    { key: "professionalism_policy", label: "Attendance and professionalism policies", type: "SHORT_TEXT", required: true, helpText: PROFESSIONALISM_POLICY },
    { key: "training_acknowledgement", label: "Training acknowledgement", type: "SHORT_TEXT", required: true, helpText: TRAINING_ACKNOWLEDGEMENT },
  ]);
}

export function additionalInfoSection(): TemplateSection {
  return sec("Additional information", "BOTH", [
    { key: "additional_info", label: "Anything else you would like us to know?", type: "LONG_TEXT", required: false },
  ]);
}
