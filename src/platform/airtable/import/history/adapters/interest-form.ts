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

/**
 * The old MS table's "Name" column is misnamed: it holds a numeric response id
 * from the Microsoft form it was exported from, not a person. All 757 of its
 * rows carry one, so reading it as a name wrote 329 applicants called "109",
 * "592" and so on. That table has no name column at all; its only other fields
 * are Email, Yale Affiliate, Terms, and two empty ones.
 *
 * A purely numeric value is therefore never a name, in EITHER table. Rejecting
 * it here rather than only for responsesOld also protects identity resolution:
 * resolveIdentities picks the first member with any truthy name, so a junk
 * "109" could otherwise beat a real name carried by the same person's
 * application row.
 */
const isNumericId = (value: string | null): boolean => value !== null && /^\d+$/.test(value);

/**
 * Yale addresses are firstname.lastname@yale.edu, so a name is recoverable for
 * the rows the old MS table left nameless. Ops chose to derive ONLY from
 * yale.edu and only when the local part is exactly two alphabetic parts: 171 of
 * those 329 people qualify. Personal addresses (omary8241@gmail.com) are left
 * nameless on purpose, because a manufactured name that looks authoritative is
 * worse than none in a tool people make decisions in.
 */
const capitalize = (s: string) =>
  s.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("-");

const nameFromYaleEmail = (email: string): { firstName: string; lastName: string } | null => {
  const [local, domain] = email.toLowerCase().split("@");
  // Any yale.edu subdomain, not just the bare one: alumni keep first.last at
  // aya.yale.edu, and requiring an exact match missed them.
  if (!domain || !/(^|\.)yale\.edu$/.test(domain) || !local) return null;
  if (!/^[a-z]+\.[a-z-]+$/.test(local)) return null;
  const [first, last] = local.split(".");
  return { firstName: capitalize(first), lastName: capitalize(last) };
};

/**
 * Some rows have a person's name sitting in the email column, because the
 * source form collected it there: "sourav roy", "vraj patel", and surnames
 * like "zentner" alongside a first name that did land correctly. A value with
 * no "@" is not an address, so when the name is otherwise blank it is better
 * read as the name than stored as a fake email.
 *
 * Values that are clearly not names either ("n/a", "sss", a street address)
 * fall through to the same blank they would have had. This never invents
 * anything: it only relocates a value the source already recorded.
 */
const nameFromMisplacedEmail = (value: string): { firstName: string; lastName: string } | null => {
  if (value.includes("@")) return null;
  const cleaned = value.trim();
  // Two alphabetic words is the shape of a name. One word could be a surname
  // but is just as likely to be junk, so require the pair.
  if (!/^[a-z]+ [a-z]+$/i.test(cleaned)) return null;
  const [first, last] = cleaned.split(/\s+/);
  return { firstName: capitalize(first.toLowerCase()), lastName: capitalize(last.toLowerCase()) };
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

      const rawName = str(record.fields[fields.name]);
      const { firstName, lastName } = isNumericId(rawName)
        ? // No name in this table at all, so recover one from the address if
          // its shape allows, then from a name misfiled into the email column.
          nameFromYaleEmail(email) ??
          nameFromMisplacedEmail(email) ?? { firstName: "", lastName: "" }
        : splitName(rawName);

      rows.push({
        source: { baseId: source.baseId, tableId: source.tables[key], recordId: record.id },
        identity: { firstName, lastName, email, netId: null },
        submittedAt: record.createdTime ? new Date(record.createdTime) : null,
      });
    }
  }
  return rows;
}
