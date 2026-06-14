import type { AvsData, Lang, Medication } from "./types";

export const initialAvsData: AvsData = {
  firstName: "",
  lastName: "",
  dob: "",
  visitDate: "",
  preferredLang: "en",
  provider: "",
  patientId: "",
  primaryReason: "",
  diagnoses: "",
  clinicalNotes: "",
  vitals: [],
  medications: [],
  followUpTimeframe: "",
  followUpNote: "",
  labs: [],
  actionItems: [],
  lifestyle: "",
  communityResources: [],
  financialResources: [],
  customResource: "",
};

export type StringFieldKey =
  | "firstName"
  | "lastName"
  | "dob"
  | "visitDate"
  | "provider"
  | "patientId"
  | "primaryReason"
  | "diagnoses"
  | "clinicalNotes"
  | "followUpTimeframe"
  | "followUpNote"
  | "lifestyle"
  | "customResource";

export type ArrayFieldKey = "vitals" | "labs" | "communityResources" | "financialResources";

export type AvsAction =
  | { type: "setField"; key: StringFieldKey; value: string }
  | { type: "setLang"; value: Lang }
  | { type: "toggle"; key: ArrayFieldKey; value: string }
  | { type: "addMed" }
  | { type: "updateMed"; index: number; key: keyof Medication; value: string }
  | { type: "removeMed"; index: number }
  | { type: "addActionItem" }
  | { type: "updateActionItem"; index: number; value: string }
  | { type: "removeActionItem"; index: number };

export function avsReducer(state: AvsData, action: AvsAction): AvsData {
  switch (action.type) {
    case "setField":
      return { ...state, [action.key]: action.value };
    case "setLang":
      return { ...state, preferredLang: action.value };
    case "toggle": {
      const current = state[action.key];
      const next = current.includes(action.value)
        ? current.filter((v) => v !== action.value)
        : [...current, action.value];
      return { ...state, [action.key]: next };
    }
    case "addMed":
      return { ...state, medications: [...state.medications, { name: "", dose: "", costSource: "" }] };
    case "updateMed":
      return {
        ...state,
        medications: state.medications.map((m, i) =>
          i === action.index ? { ...m, [action.key]: action.value } : m,
        ),
      };
    case "removeMed":
      return { ...state, medications: state.medications.filter((_, i) => i !== action.index) };
    case "addActionItem":
      return { ...state, actionItems: [...state.actionItems, ""] };
    case "updateActionItem":
      return {
        ...state,
        actionItems: state.actionItems.map((v, i) => (i === action.index ? action.value : v)),
      };
    case "removeActionItem":
      return { ...state, actionItems: state.actionItems.filter((_, i) => i !== action.index) };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
