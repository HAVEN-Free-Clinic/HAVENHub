import type { Track } from "@prisma/client";
import type { ContractLayout } from "./layout";
import type { TemplateOption } from "../templates/types";
import { GRAD_YEAR, YALE_AFFILIATION } from "../templates/content/options";

export const SYSTEM_FIELD_KEYS = [
  "name", "email", "netId", "phone", "dob", "dietary", "yaleAffiliation",
  "gradYear", "epic", "spanish", "licensedRN", "hipaa", "initials",
] as const;

export type SystemRenderKind =
  | "text" | "email" | "tel" | "date" | "select" | "checkbox" | "epicBlock" | "hipaaBlock";

export type SystemFieldSpec = {
  key: (typeof SYSTEM_FIELD_KEYS)[number];
  core: boolean;
  defaultLabel: string;
  render: SystemRenderKind;
  columns: string[];
  /** Choice list for `render: "select"`. Values are machine keys; labels are applicant-facing. */
  options?: TemplateOption[];
};

export const SYSTEM_FIELDS: Record<(typeof SYSTEM_FIELD_KEYS)[number], SystemFieldSpec> = {
  name:            { key: "name", core: true, defaultLabel: "Your name", render: "text", columns: ["firstName", "lastName"] },
  email:           { key: "email", core: true, defaultLabel: "Email", render: "email", columns: ["email"] },
  netId:           { key: "netId", core: false, defaultLabel: "NetID", render: "text", columns: ["netId"] },
  phone:           { key: "phone", core: false, defaultLabel: "Phone", render: "tel", columns: ["phone"] },
  dob:             { key: "dob", core: false, defaultLabel: "Date of birth", render: "date", columns: ["dateOfBirth"] },
  dietary:         { key: "dietary", core: false, defaultLabel: "Dietary restrictions", render: "text", columns: ["dietaryRestrictions"] },
  yaleAffiliation: { key: "yaleAffiliation", core: false, defaultLabel: "Yale affiliation", render: "select", columns: ["yaleAffiliation"], options: YALE_AFFILIATION },
  gradYear:        { key: "gradYear", core: false, defaultLabel: "Graduation year", render: "select", columns: ["gradYear"], options: GRAD_YEAR },
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

/**
 * Choice list to render for a system field, or `[]` if it isn't a choice list.
 *
 * `Person.yaleAffiliation` accumulated three vocabularies over time (recruitment
 * machine keys, the human strings /my-info writes, and Airtable imports), so a
 * stored value that isn't in the canonical list is prepended as its own option
 * rather than dropped, since otherwise re-saving the contract would erase it.
 */
export function systemFieldOptions(
  key: (typeof SYSTEM_FIELD_KEYS)[number],
  currentValue: string | undefined,
): TemplateOption[] {
  const options = SYSTEM_FIELDS[key].options;
  if (!options) return [];
  if (!currentValue || options.some((o) => o.value === currentValue)) return options;
  return [{ value: currentValue, label: currentValue }, ...options];
}

export function defaultContractLayout(track: Track): ContractLayout {
  if (track === "VOLUNTEER") return DEFAULT_CONTRACT_LAYOUT;
  // Director: same fields plus a data-privacy agreement, before the training block.
  const blocks = [...DEFAULT_CONTRACT_LAYOUT.blocks];
  const trainingIdx = blocks.findIndex((b) => b.kind === "agreement" && b.id === "training");
  blocks.splice(trainingIdx, 0, { kind: "agreement", id: "data_privacy", title: "Data privacy acknowledgement", body: "", signatureLabel: "type your full name" });
  return { blocks };
}
