import { YALE_AFFILIATION } from "../templates/content/options";

export const SYSTEM_FIELD_KEYS = [
  "name", "email", "netId", "phone", "dob", "dietary", "yaleAffiliation",
  "gradYear", "pronouns", "staffTitle", "epic", "epicIdExpiration", "spanish",
  "licensedRN", "hipaa", "initials",
] as const;

export type SystemRenderKind =
  | "text" | "email" | "tel" | "date" | "select" | "checkbox" | "epicBlock" | "hipaaBlock";

export type SystemFieldSpec = {
  key: (typeof SYSTEM_FIELD_KEYS)[number];
  core: boolean;
  defaultLabel: string;
  render: SystemRenderKind;
  columns: string[];
  options?: { value: string; label: string }[];
};

// Alias for the canonical Yale-affiliation option list. The applicant's stored
// affiliation value flows verbatim into the contract, so this must stay the
// same list used to render and validate the recruitment application form,
// not a parallel hand-written copy that would drift and blank out prefills.
export const YALE_AFFILIATION_OPTIONS = YALE_AFFILIATION;

/** Seven graduation years starting at `fromYear`, plus Other and N/A. The year
 *  is passed in rather than read from the clock so callers in a render body do
 *  not trip the react-hooks/purity rule; the page server-stamps it. */
export function gradYearOptions(fromYear: number): { value: string; label: string }[] {
  const years = Array.from({ length: 7 }, (_, i) => String(fromYear + i));
  return [
    ...years.map((y) => ({ value: y, label: y })),
    { value: "other", label: "Other" },
    { value: "na", label: "N/A" },
  ];
}

export const SYSTEM_FIELDS: Record<(typeof SYSTEM_FIELD_KEYS)[number], SystemFieldSpec> = {
  name:             { key: "name", core: true, defaultLabel: "Your name", render: "text", columns: ["firstName", "lastName"] },
  email:            { key: "email", core: true, defaultLabel: "Email", render: "email", columns: ["email"] },
  netId:            { key: "netId", core: false, defaultLabel: "NetID", render: "text", columns: ["netId"] },
  phone:            { key: "phone", core: false, defaultLabel: "Phone", render: "tel", columns: ["phone"] },
  dob:              { key: "dob", core: false, defaultLabel: "Date of birth", render: "date", columns: ["dateOfBirth"] },
  dietary:          { key: "dietary", core: false, defaultLabel: "Dietary restrictions", render: "text", columns: ["dietaryRestrictions"] },
  yaleAffiliation:  { key: "yaleAffiliation", core: false, defaultLabel: "Yale affiliation", render: "select", columns: ["yaleAffiliation"], options: [...YALE_AFFILIATION_OPTIONS] },
  gradYear:         { key: "gradYear", core: false, defaultLabel: "Graduation year", render: "select", columns: ["gradYear"] },
  pronouns:         { key: "pronouns", core: false, defaultLabel: "Pronouns (optional)", render: "text", columns: ["pronouns"] },
  staffTitle:       { key: "staffTitle", core: false, defaultLabel: "If you are a staff member, please list your official employee title and office or department", render: "text", columns: ["staffTitle"] },
  epic:             { key: "epic", core: true, defaultLabel: "Epic access", render: "epicBlock", columns: ["epicNeeded", "hasEpic", "existingEpicId", "epicAccessType", "worksWithYnhh"] },
  epicIdExpiration: { key: "epicIdExpiration", core: false, defaultLabel: "Epic ID expiration", render: "date", columns: ["epicIdExpiration"] },
  spanish:          { key: "spanish", core: false, defaultLabel: "I can speak Spanish with patients", render: "checkbox", columns: ["spanishSelfReported"] },
  licensedRN:       { key: "licensedRN", core: false, defaultLabel: "I am a licensed RN", render: "checkbox", columns: ["licensedRN"] },
  hipaa:            { key: "hipaa", core: true, defaultLabel: "HIPAA", render: "hipaaBlock", columns: ["hipaaCompletedAt", "hipaaFile"] },
  initials:         { key: "initials", core: false, defaultLabel: "Initials", render: "text", columns: ["initials"] },
};

// The default contract layouts (and the shared prose they're built from) live
// in ./defaults; re-exported here so existing importers of these two names
// keep working.
export { defaultContractLayout, DEFAULT_CONTRACT_LAYOUT } from "./defaults";
