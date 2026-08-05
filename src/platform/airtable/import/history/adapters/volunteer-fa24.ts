import type { AirtableRecord } from "../../../client";
import { deriveStage, parseOutcome } from "../stages";
import type { HistorySource } from "../sources";
import type { RawHistoryRow } from "../types";

/**
 * V-FA24 field ids. Unlike every later cycle, each table here has its OWN ids
 * for the same logical field, because these tables were authored separately
 * rather than duplicated. Verified 2026-08-05.
 */
export const FA24_FIELDS = {
  r1New:        { email: "fldfMY7ikGKiaW1Gs", status: "fldYSRiPtJhGg6DcY", first: "fldLOI1uqODcQMBPk", last: "fldSesR8hMQPdmzhm", dept1: "fldWucalULrJOkcKX", dept2: "fldpm5xjFOurMiXmo" },
  r1Returning:  { email: "fldUsUAWp6JFmZEPI", status: "fldO0xoS3TKMpyYbp", first: "fldquEu8veCz2PeYA", last: "fldxUokMmcPcppcqC", dept1: "fldSpQETSyMC9c16U", dept2: "fld5CYLXmvrtPcflN" },
  r1Switch:     { email: "fldoJBVKtrpBP2jKZ", status: "fld7NNixC6dIgb7SC", first: "fldXauc7NmUzfetqc", last: "fldS3KuO99RmGQcDp", dept1: "fldLD1gsVmMrG3OF1", dept2: "fld4Tet6p7roNbVOU" },
  r1Ineligible: { email: "fldmBjFoq1c1GUfDo", status: "fldk1CVnUTuM1n2ep", first: "fldFJYIJt6e699mQw", last: "fldeTSd2Y2atgz68r", dept1: "fldwFejmQjzDCkcsY", dept2: "fldlFY4THisLuaeGp" },
  // The Non-Yale primary field is named "Name" but is typed as an email.
  nonYale:      { email: "fld6aTmcfxG7UeTsL", status: "flddl3VrcXCKl17hg", first: null,                last: "fldPs3AVBccn6yIfX", dept1: "fldWwgNiMR1JJzNpE", dept2: "fldIq1mUOJdqtvuMS" },
  r2All:        { email: "fldU5FUdvg2kJ3GQ7" },
  finalDecisions: { email: "fld4mv32zkY4NXtIW", status: "fldBhoj8Sx3XtksrO", onboarded: "fldxPiBKiukkN0l4b", department: "fldPlk8i79eAZAF50" },
} as const;

/** Which R1 table a row came from decides its applicant type and floor outcome. */
export const FA24_R1_TABLES = [
  { key: "r1New",        applicantType: "NEW" as const,     forcedOutcome: null },
  { key: "r1Returning",  applicantType: "RENEWAL" as const, forcedOutcome: null },
  { key: "r1Switch",     applicantType: "TRANSFER" as const, forcedOutcome: null },
  { key: "r1Ineligible", applicantType: null,                forcedOutcome: "INELIGIBLE" as const },
  { key: "nonYale",      applicantType: "NEW" as const,      forcedOutcome: null },
];

export function transformVolunteerFa24(
  tables: Record<string, AirtableRecord[]>,
  source: HistorySource,
): RawHistoryRow[] {
  const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : null);

  // No link fields anywhere in this base, so downstream membership is an
  // email join. Both sides are lowercased before comparison.
  const reachedR2 = new Set(
    (tables.r2All ?? []).map((r) => lower(r.fields[FA24_FIELDS.r2All.email])).filter(Boolean),
  );
  const decisions = new Map(
    (tables.finalDecisions ?? [])
      .map((r) => [lower(r.fields[FA24_FIELDS.finalDecisions.email]), r] as const)
      .filter(([email]) => Boolean(email)),
  );

  const rows: RawHistoryRow[] = [];
  for (const { key, applicantType, forcedOutcome } of FA24_R1_TABLES) {
    const fields = FA24_FIELDS[key as keyof typeof FA24_FIELDS] as Record<string, string | null>;
    for (const record of tables[key] ?? []) {
      const email = typeof record.fields[fields.email!] === "string"
        ? (record.fields[fields.email!] as string).trim() : null;
      if (!email) continue;
      const key2 = email.toLowerCase();
      const decision = decisions.get(key2);
      const onboarded = decision?.fields[FA24_FIELDS.finalDecisions.onboarded] === true;
      const decisionRaw = decision
        ? (decision.fields[FA24_FIELDS.finalDecisions.status] as string | undefined) ?? null
        : null;
      const outcome = forcedOutcome ?? parseOutcome(decisionRaw);
      rows.push({
        source: { baseId: source.baseId, tableId: source.tables[key], recordId: record.id },
        cycle: { code: source.code, label: source.label, track: source.track, termCode: source.termCode },
        identity: {
          firstName: fields.first ? (record.fields[fields.first] as string) ?? "" : "",
          lastName: fields.last ? (record.fields[fields.last] as string) ?? "" : "",
          email,
          netId: null, // FA24 records no NetID anywhere.
        },
        applicantType,
        departmentChoicesRaw: [
          fields.dept1 ? (record.fields[fields.dept1] as string) ?? null : null,
          fields.dept2 ? (record.fields[fields.dept2] as string) ?? null : null,
        ],
        resultDepartmentRaw: decision
          ? (decision.fields[FA24_FIELDS.finalDecisions.department] as string) ?? null : null,
        furthestStage: deriveStage({
          advanced: reachedR2.has(key2),
          finalRound: reachedR2.has(key2),
          accepted: outcome === "ACCEPTED" || onboarded,
          onboarded,
        }),
        outcome,
        submittedAt: record.createdTime ? new Date(record.createdTime) : null,
        decidedAt: null,
        unmapped: null,
      });
    }
  }
  return rows;
}
