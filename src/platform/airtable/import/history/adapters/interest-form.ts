import type { AirtableRecord } from "../../../client";
import type { HistorySource } from "../sources";
import type { RawInterestRow } from "../types";

/**
 * Field ids across both interest-form tables. The old MS table
 * (responsesOld, tbl55zvZUFQgcnp04) holds 757 of this source's 1,104 rows;
 * skipping it loses most of the data. Verified 2026-08-05.
 */
export const INTEREST_FIELDS = {
  responses: { name: "fldgfooA8WuUX5y8B", email: "fldmPa8oFkr7LHQYT" },
  responsesOld: { name: "fldHaLthl8UqnJyRI", email: "fldNKxd5SwRDblQH0" },
} as const;

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
};

/**
 * Both tables carry a single Name field rather than first and last. Split on
 * the first space: everything before it is the first name, the remainder is
 * the last name. A single-token name becomes the first name with an empty
 * last name.
 */
const splitName = (name: string | null): { firstName: string; lastName: string } => {
  if (!name) return { firstName: "", lastName: "" };
  const spaceIndex = name.indexOf(" ");
  if (spaceIndex === -1) return { firstName: name, lastName: "" };
  return { firstName: name.slice(0, spaceIndex), lastName: name.slice(spaceIndex + 1).trim() };
};

export function transformInterestForm(
  tables: Record<string, AirtableRecord[]>,
  source: HistorySource,
): RawInterestRow[] {
  const rows: RawInterestRow[] = [];

  // The old MS table holds 757 of this source's 1,104 rows, so both tables
  // must be read or most of the data is lost.
  const tableConfigs = [
    { key: "responses", fields: INTEREST_FIELDS.responses },
    { key: "responsesOld", fields: INTEREST_FIELDS.responsesOld },
  ] as const;

  for (const { key, fields } of tableConfigs) {
    for (const record of tables[key] ?? []) {
      const email = str(record.fields[fields.email]);
      // A contactless row is Airtable cruft, not demonstrated interest.
      if (!email) continue;

      const { firstName, lastName } = splitName(str(record.fields[fields.name]));

      rows.push({
        source: { baseId: source.baseId, tableId: source.tables[key], recordId: record.id },
        identity: { firstName, lastName, email, netId: null },
        submittedAt: record.createdTime ? new Date(record.createdTime) : null,
      });
    }
  }
  return rows;
}
