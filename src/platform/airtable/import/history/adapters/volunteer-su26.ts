import type { AirtableRecord } from "../../../client";
import { isNetIdShaped } from "@/platform/auth/match-person";
import { deriveStage } from "../stages";
import type { HistorySource } from "../sources";
import type { RawHistoryRow } from "../types";

/**
 * V-SU26 field ids on Applicants (tblV3UrQQvIIZzFTU). This base carries link
 * fields to its own Acceptances (tblc15YeGhahLxeA9) and Contracts
 * (tblW5qmRckmvz1QGX), so the whole ladder derives from one table read, same
 * as the modern volunteer lineage. Verified 2026-08-05.
 */
export const SU26_FIELDS = {
  firstName: "fldiZWK1yycg5rwB3",
  lastName: "fldwLgLBjxGr6NYvy",
  /**
   * Full-coverage name fallback, and it is needed for the same reason as
   * primaryEmail below: returning members link an existing record instead of
   * retyping, so the direct First/Last columns are populated on only 161 of
   * 358 rows while this formula covers all 358. Verified 2026-08-06 after the
   * first production import wrote applicants with blank names.
   */
  fullName: "fldDeejw8gu41cFCX",
  /**
   * PRIMARY email source: a formula, populated on all 358 rows. Read this
   * FIRST. The direct `email` field below is populated on only 161, because
   * returning members link an existing record instead of retyping their
   * address. Reading only the direct field would drop 197 of 358 applicants
   * as contactless cruft. Verified 2026-08-05:
   *   Primary Email 358/358, Email 161/358, email from record 204/358.
   */
  primaryEmail: "fldpyzUIOubXWqrQ3",
  email: "fldA2aimGltA8NX1G",
  netId: "fldaDUQ4PIQuzUVT8",
  dept1: "fldQvDs0wg4EDTMLo",
  dept2: "fldMD1njjyNSvRR0f",
  acceptances: "fldpu3cmprXapSnoq", // link to tblc15YeGhahLxeA9
  contracts: "flds0n3Hue8Xin9h8", // link to tblW5qmRckmvz1QGX
  acceptedDept: "fldA8Afm5itWGOf7U", // lookup
  submittedAt: "fld0l5nof6dzVkDmM", // createdTime
} as const;

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
};
const linked = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
/** Formula and lookup cells can arrive either boxed or bare. */
const lookupFirst = (v: unknown): string | null => (Array.isArray(v) ? str(v[0]) : str(v));

/**
 * Direct First/Last when present, otherwise split the full-coverage Full Name
 * formula on the first space. Reading only the direct columns left applicants
 * with blank names in the first production import.
 */
const resolveName = (f: Record<string, unknown>): { firstName: string; lastName: string } => {
  const first = str(f[SU26_FIELDS.firstName]);
  const last = str(f[SU26_FIELDS.lastName]);
  if (first || last) return { firstName: first ?? "", lastName: last ?? "" };

  const full = lookupFirst(f[SU26_FIELDS.fullName]);
  if (!full) return { firstName: "", lastName: "" };
  const spaceIndex = full.indexOf(" ");
  if (spaceIndex === -1) return { firstName: full, lastName: "" };
  return { firstName: full.slice(0, spaceIndex), lastName: full.slice(spaceIndex + 1).trim() };
};

export function transformVolunteerSu26(
  tables: Record<string, AirtableRecord[]>,
  source: HistorySource,
): RawHistoryRow[] {
  const F = SU26_FIELDS;
  const rows: RawHistoryRow[] = [];

  for (const record of tables.applicants ?? []) {
    const f = record.fields;
    // Two sources, in order. See the comment on SU26_FIELDS.primaryEmail:
    // reading only the direct field drops 197 of 358 applicants.
    const email = lookupFirst(f[F.primaryEmail]) ?? str(f[F.email]);
    const rawNetId = str(f[F.netId]);
    // A nameless, contactless row is Airtable cruft, not an application.
    if (!email && !rawNetId) continue;

    const unmapped: Record<string, unknown> = {};
    let netId: string | null = null;
    if (rawNetId && isNetIdShaped(rawNetId)) netId = rawNetId.toLowerCase();
    else if (rawNetId) unmapped.rejectedNetId = rawNetId;

    const accepted = linked(f[F.acceptances]);
    const onboarded = linked(f[F.contracts]);
    const furthestStage = deriveStage({
      // Neither table carries a Round 1 / Round 2 progression signal; only
      // acceptance and onboarding are recorded here.
      advanced: false,
      finalRound: false,
      accepted,
      onboarded,
    });

    const rawSubmitted = str(f[F.submittedAt]);
    const submittedAt = rawSubmitted
      ? new Date(rawSubmitted)
      : record.createdTime
        ? new Date(record.createdTime)
        : null;

    rows.push({
      source: { baseId: source.baseId, tableId: source.tables.applicants, recordId: record.id },
      cycle: { code: source.code, label: source.label, track: source.track, termCode: source.termCode },
      identity: { ...resolveName(f), email, netId },
      applicantType: null,
      departmentChoicesRaw: [str(f[F.dept1]), str(f[F.dept2])],
      resultDepartmentRaw: lookupFirst(f[F.acceptedDept]),
      furthestStage,
      outcome: accepted ? "ACCEPTED" : "NO_DECISION",
      submittedAt,
      decidedAt: null,
      unmapped: Object.keys(unmapped).length ? unmapped : null,
    });
  }
  return rows;
}
