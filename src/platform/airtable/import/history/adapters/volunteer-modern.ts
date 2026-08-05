import type { AirtableRecord } from "../../../client";
import { isNetIdShaped } from "@/platform/auth/match-person";
import { deriveStage, parseOutcome } from "../stages";
import type { HistorySource } from "../sources";
import type { RawHistoryRow } from "../types";

/**
 * Field ids on Round 1 Applications (tblJPuEMyBq5c2x0W). Verified identical
 * across V-SP25, V-SU25, V-FA25 and V-SP26 on 2026-08-05: each base was
 * duplicated from its predecessor, so Airtable preserved the ids of every
 * field that already existed. Later cycles only ADD fields.
 */
export const MODERN_VOLUNTEER_FIELDS = {
  firstName: "fldQA7KFcUNM5cUqn",
  lastName: "fldX0RAj3S0psMSSp",
  email: "fldkynQt6MUSpmkhv",
  netId: "fldtAreIGp2junzjR",
  dept1: "fldivjUqzeXPczHyH",
  dept2: "fldQfIQswsmCSyoNV",
  r1Selections: "fldjynzhT3vXhfvTi",
  r2Applications: "fldt1KIkLCdkOpBwu",
  r2Selections: "fldAOwxW8t639e5uk",
  finalDecisions: "fldrwLEgdh6Acf3Tl",
  fdDecision: "fld3PcyqYyRONmiEi",
  /** SP26 only. That cycle recorded nothing else. */
  acceptedCheckbox: "fldzBRNBv4AjmsIb0",
} as const;

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
};
const linked = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
const lookupFirst = (v: unknown): string | null =>
  Array.isArray(v) ? str(v[0]) : str(v);

export function transformModernVolunteer(
  records: AirtableRecord[],
  source: HistorySource,
): RawHistoryRow[] {
  const F = MODERN_VOLUNTEER_FIELDS;
  const rows: RawHistoryRow[] = [];

  for (const record of records) {
    const f = record.fields;
    const email = str(f[F.email]);
    const rawNetId = str(f[F.netId]);
    // A nameless, contactless row is Airtable cruft, not an application.
    if (!email && !rawNetId) continue;

    const unmapped: Record<string, unknown> = {};
    let netId: string | null = null;
    if (rawNetId && isNetIdShaped(rawNetId)) netId = rawNetId.toLowerCase();
    else if (rawNetId) unmapped.rejectedNetId = rawNetId;

    const decisionRaw = lookupFirst(f[F.fdDecision]);
    const outcome = parseOutcome(decisionRaw);
    if (outcome === "UNKNOWN") unmapped.decision = decisionRaw;

    const acceptedByCheckbox = f[F.acceptedCheckbox] === true;
    const furthestStage = deriveStage({
      advanced: linked(f[F.r1Selections]),
      finalRound: linked(f[F.r2Applications]) || linked(f[F.r2Selections]),
      accepted: outcome === "ACCEPTED" || acceptedByCheckbox,
      // This lineage records onboarding elsewhere; never inferred here.
      onboarded: false,
    });

    rows.push({
      source: { baseId: source.baseId, tableId: source.tables.applications, recordId: record.id },
      cycle: { code: source.code, label: source.label, track: source.track, termCode: source.termCode },
      identity: { firstName: str(f[F.firstName]) ?? "", lastName: str(f[F.lastName]) ?? "", email, netId },
      applicantType: null,
      departmentChoicesRaw: [str(f[F.dept1]), str(f[F.dept2])],
      resultDepartmentRaw: null,
      furthestStage,
      // The checkbox is an acceptance with no recorded decision string.
      outcome: outcome === "NO_DECISION" && acceptedByCheckbox ? "ACCEPTED" : outcome,
      submittedAt: record.createdTime ? new Date(record.createdTime) : null,
      decidedAt: null,
      unmapped: Object.keys(unmapped).length ? unmapped : null,
    });
  }
  return rows;
}
