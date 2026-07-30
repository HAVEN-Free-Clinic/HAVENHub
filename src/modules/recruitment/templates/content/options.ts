// Verbatim from the live Airtable volunteer application (option lists captured
// this session). Values are stable machine keys; labels are applicant-facing.
import type { TemplateOption } from "../types";
import { YALE_AFFILIATIONS } from "@/platform/affiliation";

// The canonical list moved to @/platform/affiliation so that /my-info and the
// admin person editor can render the same options: eslint forbids one module
// from importing another, which is exactly why /my-info grew a parallel
// hand-written copy. Re-exported here, typed as TemplateOption[] (structurally
// identical to AffiliationOption), so recruitment's importers are unchanged.
export const YALE_AFFILIATION: TemplateOption[] = YALE_AFFILIATIONS;

export const GRAD_YEAR: TemplateOption[] = [
  ...["2026", "2027", "2028", "2029", "2030", "2031", "2032", "2033"].map((y) => ({ value: y, label: y })),
  { value: "other", label: "Other" },
];

export const SPANISH_PROFICIENCY: TemplateOption[] = [
  { value: "none", label: "None" },
  { value: "some", label: "Some" },
  { value: "conversational", label: "Conversational" },
  { value: "fluent_native", label: "Fluent (native)" },
  { value: "fluent_non_native", label: "Fluent (non-native)" },
];

export const MEDICAL_CERTIFICATIONS: TemplateOption[] = [
  { value: "RN", label: "RN (Registered Nurse)" },
  { value: "LPN", label: "LPN (Licensed Practical Nurse)" },
  { value: "APRN", label: "APRN (Advanced Practice Registered Nurse)" },
  { value: "PA", label: "PA (Physician Associate)" },
  { value: "EMT", label: "EMT (Emergency Medical Technician, Basic/Advanced/Paramedic)" },
  { value: "pharmacist", label: "Pharmacist" },
  { value: "pharmacy_tech", label: "Pharmacy Technician" },
  { value: "other", label: "Other" },
];

export const YES_NO: TemplateOption[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];
