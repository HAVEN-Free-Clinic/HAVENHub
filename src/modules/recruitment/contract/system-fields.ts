import type { ContractLayout } from "./layout";

export const SYSTEM_FIELD_KEYS = [
  "name", "email", "netId", "phone", "dob", "dietary", "yaleAffiliation",
  "gradYear", "epic", "spanish", "licensedRN", "hipaa", "initials",
] as const;

export type SystemRenderKind =
  | "text" | "email" | "tel" | "date" | "checkbox" | "epicBlock" | "hipaaBlock";

export type SystemFieldSpec = {
  key: (typeof SYSTEM_FIELD_KEYS)[number];
  core: boolean;
  defaultLabel: string;
  render: SystemRenderKind;
  columns: string[];
};

export const SYSTEM_FIELDS: Record<(typeof SYSTEM_FIELD_KEYS)[number], SystemFieldSpec> = {
  name:            { key: "name", core: true, defaultLabel: "Your name", render: "text", columns: ["firstName", "lastName"] },
  email:           { key: "email", core: true, defaultLabel: "Email", render: "email", columns: ["email"] },
  netId:           { key: "netId", core: false, defaultLabel: "NetID", render: "text", columns: ["netId"] },
  phone:           { key: "phone", core: false, defaultLabel: "Phone", render: "tel", columns: ["phone"] },
  dob:             { key: "dob", core: false, defaultLabel: "Date of birth", render: "date", columns: ["dateOfBirth"] },
  dietary:         { key: "dietary", core: false, defaultLabel: "Dietary restrictions", render: "text", columns: ["dietaryRestrictions"] },
  yaleAffiliation: { key: "yaleAffiliation", core: false, defaultLabel: "Yale affiliation", render: "text", columns: ["yaleAffiliation"] },
  gradYear:        { key: "gradYear", core: false, defaultLabel: "Graduation year", render: "text", columns: ["gradYear"] },
  epic:            { key: "epic", core: true, defaultLabel: "Epic access", render: "epicBlock", columns: ["epicNeeded", "hasEpic", "existingEpicId", "epicAccessType", "worksWithYnhh"] },
  spanish:         { key: "spanish", core: false, defaultLabel: "I can speak Spanish with patients", render: "checkbox", columns: ["spanishSelfReported"] },
  licensedRN:      { key: "licensedRN", core: false, defaultLabel: "I am a licensed RN", render: "checkbox", columns: ["licensedRN"] },
  hipaa:           { key: "hipaa", core: true, defaultLabel: "HIPAA", render: "hipaaBlock", columns: ["hipaaCompletedAt", "hipaaFile"] },
  initials:        { key: "initials", core: false, defaultLabel: "Initials", render: "text", columns: ["initials"] },
};

// Reproduces src/app/onboard/[token]/onboard-form.tsx field-for-field. Agreement
// bodies are empty so the rendered form is identical to today (label + signature
// only); admins fill prose later. Order matches the current form's sections.
export const DEFAULT_CONTRACT_LAYOUT: ContractLayout = {
  blocks: [
    { kind: "system_field", systemKey: "name" },
    { kind: "system_field", systemKey: "email" },
    { kind: "system_field", systemKey: "netId" },
    { kind: "system_field", systemKey: "phone" },
    { kind: "system_field", systemKey: "dob" },
    { kind: "system_field", systemKey: "dietary" },
    { kind: "system_field", systemKey: "yaleAffiliation" },
    { kind: "system_field", systemKey: "gradYear" },
    { kind: "agreement", id: "agreement", title: "Volunteer agreement", body: "", signatureLabel: "type your full name" },
    { kind: "agreement", id: "professionalism", title: "Professionalism policy", body: "", signatureLabel: "type your full name" },
    { kind: "agreement", id: "training", title: "Training acknowledgement", body: "", signatureLabel: "type your full name" },
    { kind: "system_field", systemKey: "initials" },
    { kind: "system_field", systemKey: "epic" },
    { kind: "system_field", systemKey: "spanish" },
    { kind: "system_field", systemKey: "licensedRN" },
    { kind: "system_field", systemKey: "hipaa" },
  ],
};
