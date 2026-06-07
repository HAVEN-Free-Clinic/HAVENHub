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
 * ALL_PEOPLE_FIELDS doubles as the mirrored text-field set used by
 * personMirrorPayload and MIRRORED_FIELDS in mirror.ts. Adding an attachment
 * field there would corrupt the mirror payload because the mirror only handles
 * scalar text fields. Attachment field IDs must live in this separate constant.
 */
export const ALL_PEOPLE_ATTACHMENT_FIELDS = {
  hipaaCertificate: "fld1k09CQVK2VSIJM",
} as const;
