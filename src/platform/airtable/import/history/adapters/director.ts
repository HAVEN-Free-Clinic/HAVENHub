import type { AirtableRecord } from "../../../client";
import { isNetIdShaped } from "@/platform/auth/match-person";
import { deriveStage, parseOutcome } from "../stages";
import type { HistorySource } from "../sources";
import type { RawHistoryRow } from "../types";

/**
 * Field ids on the director Applications table (tbluFoybFPBjBAXyk). Stable
 * across D-FA24, D-SU25, D-FA25 and D-SU26 for the same duplication reason as
 * the volunteer lineage.
 */
export const DIRECTOR_FIELDS = {
  firstName: "fldmyKP0uuIvMWo2F",
  lastName: "fldr0cJ1wWVMB9HjJ",
  email: "flddxvLy47P1dotdt",
  /**
   * SECOND email source, and it is not optional. D-SU26 routes most applicants
   * through a linked record, so the direct Yale Email field is EMPTY on 57 of
   * its 76 rows while this lookup carries 58. Reading only `email` would drop
   * three quarters of that cycle as contactless cruft. Verified 2026-08-05:
   *   D-SU26: Yale Email 19/76, email from record 58/76, union 75/76.
   * Absent on the older director bases, where `fields[...]` is simply
   * undefined and the fallback is a no-op.
   */
  emailFromRecord: "fldERuDIrmqOiLrzC",
  netId: "fldDT16TCdgMZmB9S",
  dept1: "fldQJbP4sHT2w2Vit",
  dept2: "fldGotOFXGfqJr17b",
  dept3: "fldFZROZWVmc9aX7Z",
  interviews: "fldYYMi71F7i2nYPM",
  decisions: "fldTlrJkHmNXvQZAS",
  contracts: "fldcFW0hsfHRsQhsk",
  /**
   * SECOND contract link, and it is the ONLY one D-SU26 uses. Verified
   * 2026-08-05 on that base: `contracts` is populated on 0 of 76 rows while
   * this field carries 36. Reading only `contracts` loses every D-SU26
   * onboarding. Absent on the older bases, where it reads as undefined.
   */
  contractsAlt: "fldG74yBW1LjC6gib",
  returningDepartment: "fldcdPQc9rX8UgYj0",
} as const;

/**
 * Verified Final Decisions field ids (`tblfw1kjlBc5fULrY`).
 */
export const DIRECTOR_DECISION_FIELDS = {
  email: "fld5VMpMm0E4Y0r2D",       // Candidate Email (lookup)
  netId: "fldpZnT1Y7b27OzEv",       // Candidate Yale NetID (lookup)
  status: "fldH8btzgKjLu3b6j",      // Status (singleLineText)
  departmentHire: "fldfUyRMWRw3d6IWs", // Department HIRE (singleSelect)
} as const;

/**
 * D-SU26 alone records outcomes in an Acceptances table (tblqM7b0f5srEmbBw,
 * 36 rows) instead of Final Decisions, which that base does not have. Like
 * Final Decisions it carries no link back to Applications, so the join is
 * again by lowercased email. Verified 2026-08-05: all 36 acceptance emails
 * resolve, matching 37 of the 76 applications, and all 36 carry a department.
 */
export const DIRECTOR_ACCEPTANCE_FIELDS = {
  email: "fldveBn6WeR9iDQBd",       // Email (lookup)
  department: "fldApydh1v6TazK3T",  // Department (lookup)
} as const;

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
};
const linked = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/** Lookup cells arrive as single-element arrays. */
const lookupFirst = (v: unknown): string | null => (Array.isArray(v) ? str(v[0]) : str(v));

export function transformDirector(
  tables: Record<string, AirtableRecord[]>,
  source: HistorySource,
): RawHistoryRow[] {
  const F = DIRECTOR_FIELDS;
  const D = DIRECTOR_DECISION_FIELDS;
  const A = DIRECTOR_ACCEPTANCE_FIELDS;
  const rows: RawHistoryRow[] = [];

  // Final Decisions has no link back to Applications, so the join is by
  // lowercased email. D-SU26 has no such table; an absent table is normal,
  // not an error, and simply leaves every decision unresolved.
  const decisions = new Map<string, AirtableRecord>();
  for (const record of tables.finalDecisions ?? []) {
    const email = lookupFirst(record.fields[D.email])?.toLowerCase();
    if (email) decisions.set(email, record);
  }

  // D-SU26 only. Same story as Final Decisions: no link back, so join by
  // lowercased email. Absent on every other director base.
  const acceptances = new Map<string, AirtableRecord>();
  for (const record of tables.acceptances ?? []) {
    const email = lookupFirst(record.fields[A.email])?.toLowerCase();
    if (email) acceptances.set(email, record);
  }

  for (const record of tables.applications ?? []) {
    const f = record.fields;
    // Two sources, in order. See the comment on DIRECTOR_FIELDS.emailFromRecord:
    // reading only the direct field drops 57 of D-SU26's 76 applicants.
    const email = str(f[F.email]) ?? lookupFirst(f[F.emailFromRecord]);
    const rawNetId = str(f[F.netId]);
    if (!email && !rawNetId) continue;

    const unmapped: Record<string, unknown> = {};
    let netId: string | null = null;
    if (rawNetId && isNetIdShaped(rawNetId)) netId = rawNetId.toLowerCase();
    else if (rawNetId) unmapped.rejectedNetId = rawNetId;

    const key = email?.toLowerCase();
    const decision = key ? decisions.get(key) : undefined;
    const acceptance = key ? acceptances.get(key) : undefined;
    const decisionRaw = decision ? str(decision.fields[D.status]) : null;
    const outcome = parseOutcome(decisionRaw);
    if (outcome === "UNKNOWN") unmapped.decision = decisionRaw;

    // Either contract field counts. D-SU26 populates only the second.
    const onboarded = linked(f[F.contracts]) || linked(f[F.contractsAlt]);
    const furthestStage = deriveStage({
      advanced: linked(f[F.interviews]) || linked(f[F.decisions]),
      finalRound: linked(f[F.interviews]),
      accepted: onboarded || outcome === "ACCEPTED" || acceptance !== undefined,
      onboarded,
    });

    rows.push({
      source: { baseId: source.baseId, tableId: source.tables.applications, recordId: record.id },
      cycle: { code: source.code, label: source.label, track: source.track, termCode: source.termCode },
      identity: { firstName: str(f[F.firstName]) ?? "", lastName: str(f[F.lastName]) ?? "", email, netId },
      applicantType: linked(f[F.returningDepartment]) ? "RENEWAL" : null,
      departmentChoicesRaw: [str(f[F.dept1]), str(f[F.dept2]), str(f[F.dept3])],
      resultDepartmentRaw:
        (decision ? str(decision.fields[D.departmentHire]) : null) ??
        (acceptance ? lookupFirst(acceptance.fields[A.department]) : null),
      furthestStage,
      // A contract or an acceptance row is proof of acceptance even when no
      // decision row survives. D-SU26 has no Final Decisions table at all.
      outcome:
        outcome === "NO_DECISION" && (onboarded || acceptance !== undefined)
          ? "ACCEPTED"
          : outcome,
      submittedAt: record.createdTime ? new Date(record.createdTime) : null,
      decidedAt: null,
      unmapped: Object.keys(unmapped).length ? unmapped : null,
    });
  }
  return rows;
}
