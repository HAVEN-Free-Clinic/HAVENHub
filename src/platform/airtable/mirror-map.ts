import type { Person } from "@prisma/client";
import { ALL_PEOPLE_FIELDS } from "./fields";

/**
 * The fields HAVEN Hub OWNS in the mirror target. Everything else in the
 * Airtable table (legacy fields, automations) is never touched.
 */
export function personMirrorPayload(person: Person): Record<string, unknown> {
  return {
    [ALL_PEOPLE_FIELDS.name]: person.name,
    [ALL_PEOPLE_FIELDS.netId]: person.netId ?? "",
    [ALL_PEOPLE_FIELDS.contactEmail]: person.contactEmail ?? "",
    [ALL_PEOPLE_FIELDS.phone]: person.phone ?? "",
    [ALL_PEOPLE_FIELDS.epicId]: person.epicId ?? "",
    [ALL_PEOPLE_FIELDS.yaleAffiliation]: person.yaleAffiliation ?? "",
    [ALL_PEOPLE_FIELDS.gradYear]: person.gradYear ?? "",
  };
}
