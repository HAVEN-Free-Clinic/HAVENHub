import type { AirtableRecord } from "../client";
import { ALL_PEOPLE_FIELDS, SU26_ROSTER_FIELDS, type RosterFieldIds } from "../fields";

export type PersonImport = {
  airtableRecordId: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  phone: string | null;
  epicId: string | null;
  yaleAffiliation: string | null;
  gradYear: string | null;
};

export type RosterImport = {
  departments: Array<{ code: string; name: string }>;
  memberships: Array<{
    departmentCode: string;
    personRecordId: string;
    kind: "DIRECTOR" | "VOLUNTEER";
  }>;
};

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : null;
};

export function transformPeople(records: AirtableRecord[]): PersonImport[] {
  const out: PersonImport[] = [];
  for (const record of records) {
    const f = record.fields;
    const name = str(f[ALL_PEOPLE_FIELDS.name]);
    if (!name) continue; // nameless rows are Airtable cruft, not people
    const contactEmail = str(f[ALL_PEOPLE_FIELDS.contactEmail])?.toLowerCase() ?? null;
    out.push({
      airtableRecordId: record.id,
      name,
      netId: str(f[ALL_PEOPLE_FIELDS.netId])?.toLowerCase() ?? null,
      contactEmail,
      phone: str(f[ALL_PEOPLE_FIELDS.phone]),
      epicId: str(f[ALL_PEOPLE_FIELDS.epicId]),
      yaleAffiliation: str(f[ALL_PEOPLE_FIELDS.yaleAffiliation]),
      gradYear: str(f[ALL_PEOPLE_FIELDS.gradYear]),
    });
  }
  return out;
}

/**
 * Roster rows -> departments + membership links. `fields` defaults to the SU 26
 * roster's ids so existing callers are unchanged; the historical-term import
 * passes the ids of whichever term's roster table it is reading.
 */
export function transformRoster(
  records: AirtableRecord[],
  fields: RosterFieldIds = SU26_ROSTER_FIELDS,
): RosterImport {
  const departments: RosterImport["departments"] = [];
  const memberships: RosterImport["memberships"] = [];
  for (const record of records) {
    const code = str(record.fields[fields.departmentName]);
    if (!code) continue;
    departments.push({ code, name: code });
    const links = (key: string): string[] =>
      Array.isArray(record.fields[key]) ? (record.fields[key] as string[]) : [];
    for (const personRecordId of links(fields.directors)) {
      memberships.push({ departmentCode: code, personRecordId, kind: "DIRECTOR" });
    }
    for (const personRecordId of links(fields.volunteers)) {
      memberships.push({ departmentCode: code, personRecordId, kind: "VOLUNTEER" });
    }
  }
  return { departments, memberships };
}
