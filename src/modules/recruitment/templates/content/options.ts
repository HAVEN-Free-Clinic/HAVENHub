// Verbatim from the live Airtable volunteer application (option lists captured
// this session). Values are stable machine keys; labels are applicant-facing.
import type { TemplateOption } from "../types";

export const YALE_AFFILIATION: TemplateOption[] = [
  { value: "yale_college", label: "Yale College" },
  { value: "divinity", label: "Yale School of Divinity" },
  { value: "gsas", label: "Yale Graduate School of Arts and Sciences (GSAS)" },
  { value: "jackson", label: "Yale Jackson School of Global Affairs" },
  { value: "law", label: "Yale Law School (YLS)" },
  { value: "som", label: "Yale School of Management (SOM)" },
  { value: "ysm_md", label: "Yale School of Medicine (YSM), MD or MD/PhD" },
  { value: "ysm_pa", label: "Yale School of Medicine (YSM), PA" },
  { value: "ysn", label: "Yale School of Nursing (YSN)" },
  { value: "ysph", label: "Yale School of Public Health (YSPH)" },
  { value: "staff", label: "Yale Staff" },
  { value: "other_yale", label: "Other Yale Affiliation" },
  { value: "non_yale", label: "I am NOT a Yale Affiliate" },
];

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
