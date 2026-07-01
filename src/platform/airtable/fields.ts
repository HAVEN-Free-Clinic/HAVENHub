/** All People (tblnHgBpknuqWvx9c) field ids. Field ids survive renames; names do not. */
export const ALL_PEOPLE_FIELDS = {
  name: "fldpyuv6yjNET25Ok",
  netId: "fldfUCriYdc35qVSK",
  contactEmail: "fldTQO03cHW0HlqjC",
  phone: "fldal7QxzkzyTPbes",
  epicId: "fldbhtCcf1VKKUI9A",
  yaleAffiliation: "fld3XOz6pMx4tY8Nk",
  gradYear: "fld0doB6wtaypevj0",
} as const;

/** SU 26 roster (tbl2VrP1uqwFt7QNQ) field ids. */
export const SU26_ROSTER_FIELDS = {
  departmentName: "fldBIGmgM2dU0vFUQ",
  directors: "fldtKUkW1wwzVBQdo",
  volunteers: "fldd6ENTWgPHmprMj",
} as const;

/**
 * Attachment fields on All People that are NOT included in ALL_PEOPLE_FIELDS.
 *
 * ALL_PEOPLE_FIELDS lists the scalar text fields the importer maps; an
 * attachment field there would not round-trip as text. Attachment field IDs
 * must live in this separate constant.
 */
export const ALL_PEOPLE_ATTACHMENT_FIELDS = {
  hipaaCertificate: "fld1k09CQVK2VSIJM",
} as const;

/** Compliance table id (tblxmEYGZ1ZKqSeK4). Lives in the same base as All People. */
export const COMPLIANCE_TABLE_ID = "tblxmEYGZ1ZKqSeK4";

/** Compliance table "Names" link field: array of linked All People record ids. */
export const COMPLIANCE_NAMES_LINK_FIELD = "fldcaF7NQu6JObuq6";

/** Compliance table (tblxmEYGZ1ZKqSeK4) "Added to EHS?" checkbox field id. */
export const ADDED_TO_EHS_FIELD = "fld3gfbuD5rASyD8Z";

/** Compliance table (tblxmEYGZ1ZKqSeK4) EHS training checkbox fields, keyed by field id,
 *  mapped to the seeded EhsTraining.name they correspond to. */
export const EHS_CHECKBOX_FIELDS: { fieldId: string; trainingName: string }[] = [
  { fieldId: "fldQgdujeCMk5dVVH", trainingName: "Chemical - Hazard Communication" },
  { fieldId: "fldWwugy9nikSiLtZ", trainingName: "Biological - TB Awareness" },
  { fieldId: "fldZ3NCYwqVTCXBs7", trainingName: "BBP Clinical" },
  { fieldId: "fldm7ZbNyYVf07VSp", trainingName: "BBP Student" },
  { fieldId: "fld8KiByAuWEUKnoj", trainingName: "TB Baseline Screening" },
  { fieldId: "fld56ALUQbZUfCpWi", trainingName: "Physical Safety - Respiration" },
];
