import type { AirtableRecord } from "../client";
import { ALL_PEOPLE_FIELDS, SU26_ROSTER_FIELDS, type RosterFieldIds } from "../fields";
import { isNetIdShaped } from "@/platform/auth/match-person";
import { normalizeAffiliation } from "@/platform/affiliation";

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

export type PeopleImport = {
  people: PersonImport[];
  /**
   * Airtable NetID cells that do not look like a NetID, dropped rather than
   * written. Reported so ops can see and correct the source row.
   */
  rejectedNetIds: Array<{ recordId: string; name: string; value: string }>;
};

export function transformPeople(records: AirtableRecord[]): PeopleImport {
  const people: PersonImport[] = [];
  const rejectedNetIds: PeopleImport["rejectedNetIds"] = [];
  for (const record of records) {
    const f = record.fields;
    const name = str(f[ALL_PEOPLE_FIELDS.name]);
    if (!name) continue; // nameless rows are Airtable cruft, not people
    const contactEmail = str(f[ALL_PEOPLE_FIELDS.contactEmail])?.toLowerCase() ?? null;

    // Only a NetID-shaped value reaches Person.netId. Members with no Yale NetID
    // (YNHH staff, community volunteers) have had their work address typed into
    // this cell instead; that value can never match a Yale sign-in, and it would
    // land in the NetID column of the YNHH Epic access PDF. Those members sign in
    // through the non-Yale member email link, which keys off contactEmail, so
    // dropping the bad value costs them nothing.
    const rawNetId = str(f[ALL_PEOPLE_FIELDS.netId]);
    let netId: string | null = null;
    if (rawNetId && isNetIdShaped(rawNetId)) {
      netId = rawNetId.toLowerCase();
    } else if (rawNetId) {
      rejectedNetIds.push({ recordId: record.id, name, value: rawNetId });
    }

    people.push({
      airtableRecordId: record.id,
      name,
      netId,
      contactEmail,
      phone: str(f[ALL_PEOPLE_FIELDS.phone]),
      epicId: str(f[ALL_PEOPLE_FIELDS.epicId]),
      // Normalized on the way in so an import cannot re-pollute the column with a
      // fourth vocabulary after the backfill. Unrecognized values pass through.
      yaleAffiliation: normalizeAffiliation(str(f[ALL_PEOPLE_FIELDS.yaleAffiliation])),
      gradYear: str(f[ALL_PEOPLE_FIELDS.gradYear]),
    });
  }
  return { people, rejectedNetIds };
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
