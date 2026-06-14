export type Lang = "en" | "es";

export type Medication = {
  name: string;
  dose: string;
  costSource: string;
};

/** Raw form state. Free-text fields are printed as typed. */
export type AvsData = {
  firstName: string;
  lastName: string;
  dob: string; // ISO yyyy-mm-dd or ""
  visitDate: string; // ISO yyyy-mm-dd or ""
  preferredLang: Lang; // chosen language for the generated PDF
  provider: string;
  patientId: string;
  primaryReason: string;
  diagnoses: string;
  clinicalNotes: string;
  vitals: string[]; // VITALS keys
  medications: Medication[];
  followUpTimeframe: string; // FOLLOW_UP key or ""
  followUpNote: string;
  labs: string[]; // LABS keys
  actionItems: string[];
  lifestyle: string;
  communityResources: string[]; // COMMUNITY_RESOURCES keys
  financialResources: string[]; // FINANCIAL_RESOURCES keys
  customResource: string;
};

/** Localized, render-ready summary model produced by buildSummary. */
export type SummaryItem =
  | { kind: "text"; label: string; value: string }
  | { kind: "tags"; label: string; values: string[] }
  | { kind: "list"; label: string; values: string[] }
  | { kind: "meds"; label: string; meds: Medication[] };

export type SummaryBlock = {
  heading: string;
  items: SummaryItem[];
};

export type LocalizedSummary = {
  lang: Lang;
  docTitle: string;
  headerName: string;
  visitDateLabel: string; // localized "Visit date" label
  visitDateValue: string; // localized formatted date
  blocks: SummaryBlock[];
  disclaimer: string;
};
