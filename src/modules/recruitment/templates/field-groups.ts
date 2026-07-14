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
    { key: "yale_affiliation_other", label: "If other or staff, please specify your school/title and department", type: "SHORT_TEXT", required: false },
    { key: "grad_year", label: "Graduation year", type: "SINGLE_SELECT", required: true, options: GRAD_YEAR },
  ], { description: "If you are a returning volunteer, your record is pulled automatically and you can skip this section." });
}

export function eligibilitySection(): TemplateSection {
  return sec("Medical and language experience", "NEW", [
    { key: "licensed_professional", label: "Are you a licensed medical professional? (Including EMT)", type: "SINGLE_SELECT", required: true, options: YES_NO },
    { key: "medical_certifications", label: "If you hold active certifications/licenses, please select all that apply", type: "MULTI_SELECT", required: false, options: MEDICAL_CERTIFICATIONS },
    { key: "medical_details", label: "Medical professional details", type: "SHORT_TEXT", required: false },
  ]);
}

export function languagesSection(): TemplateSection {
  return sec("Languages", "NEW", [
    { key: "spanish_proficiency", label: "Spanish proficiency level", type: "SINGLE_SELECT", required: true, options: SPANISH_PROFICIENCY,
      helpText: "If you wish to speak Spanish at HAVEN (regardless of role) you must pass an assessment with the Department of Interpretation and Diversity. Everyone selecting Conversational or above will be invited to this assessment." },
    { key: "other_languages", label: "Do you speak other languages?", type: "SINGLE_SELECT", required: true, options: YES_NO },
    { key: "other_languages_detail", label: "Which other languages do you speak?", type: "SHORT_TEXT", required: false },
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

export function volunteerDepartmentSection(): TemplateSection {
  return sec("Department preference", "BOTH", [
    { key: "department_choice", label: "Department / position preference", type: "DEPARTMENT_CHOICE", required: true },
    { key: "switch_departments", label: "Would you be willing to switch departments?", type: "SINGLE_SELECT", required: false, options: YES_NO },
    { key: "department_flexibility", label: "Are you flexible in your department choice?", type: "SINGLE_SELECT", required: false, options: YES_NO },
    { key: "resume", label: "Resume", type: "FILE", required: true, helpText: "Please upload your resume here." },
  ], { description: "See department descriptions at havenfreeclinic.com/apply." });
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
