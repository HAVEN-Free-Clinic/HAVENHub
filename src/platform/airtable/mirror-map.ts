import type { Person } from "@prisma/client";
import { ALL_PEOPLE_FIELDS } from "./fields";

/**
 * The shape of a field map: same logical keys as ALL_PEOPLE_FIELDS,
 * but the string values are the actual field IDs for a specific target base.
 * Use ALL_PEOPLE_FIELDS for production; provide a custom map for the sandbox
 * (whose field IDs differ because it was created separately).
 */
export type PersonFieldMap = Record<keyof typeof ALL_PEOPLE_FIELDS, string>;

const REQUIRED_KEYS: ReadonlyArray<keyof PersonFieldMap> = [
  "name",
  "netId",
  "contactEmail",
  "phone",
  "epicId",
  "yaleAffiliation",
  "gradYear",
];

/**
 * Parse an optional JSON string into a PersonFieldMap.
 * Returns ALL_PEOPLE_FIELDS when the input is undefined (production defaults).
 * Throws a descriptive error when the JSON is malformed or missing any of the
 * seven required keys.
 */
export function parseFieldMap(json: string | undefined): PersonFieldMap {
  if (json === undefined) return { ...ALL_PEOPLE_FIELDS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      `AIRTABLE_MIRROR_FIELD_MAP is not valid JSON. Provide a JSON object with keys: ${REQUIRED_KEYS.join(", ")}.`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`AIRTABLE_MIRROR_FIELD_MAP must be a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  const missing = REQUIRED_KEYS.filter((k) => typeof obj[k] !== "string" || !(obj[k] as string).length);
  if (missing.length > 0) {
    throw new Error(
      `AIRTABLE_MIRROR_FIELD_MAP is missing required string keys: ${missing.join(", ")}.`
    );
  }
  return {
    name: obj.name as string,
    netId: obj.netId as string,
    contactEmail: obj.contactEmail as string,
    phone: obj.phone as string,
    epicId: obj.epicId as string,
    yaleAffiliation: obj.yaleAffiliation as string,
    gradYear: obj.gradYear as string,
  };
}

/**
 * The fields HAVEN Hub OWNS in the mirror target. Everything else in the
 * Airtable table (legacy fields, automations) is never touched.
 * Pass a custom fieldMap for targets whose field IDs differ from production
 * (e.g. the sandbox base).
 */
export function personMirrorPayload(
  person: Person,
  fieldMap: PersonFieldMap = ALL_PEOPLE_FIELDS
): Record<string, unknown> {
  return {
    [fieldMap.name]: person.name,
    [fieldMap.netId]: person.netId ?? "",
    [fieldMap.contactEmail]: person.contactEmail ?? "",
    [fieldMap.phone]: person.phone ?? "",
    [fieldMap.epicId]: person.epicId ?? "",
    [fieldMap.yaleAffiliation]: person.yaleAffiliation ?? "",
    [fieldMap.gradYear]: person.gradYear ?? "",
  };
}
