import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { resolveIdentities, type IdentityInput, type ResolvedIdentity } from "./identity";
import { resolveDepartmentCode, resolveDepartmentCodes } from "./departments";
import type { RawHistoryRow, RawInterestRow } from "./types";

export type ImportReport = {
  dryRun: boolean;
  perSource: Array<{
    code: string;
    rows: number;
    byStage: Record<string, number>;
    byOutcome: Record<string, number>;
  }>;
  identities: { rows: number; resolved: number; multiCycle: number };
  /** Raw department labels no adapter or resolver could map to a Hub code. */
  unmappedDepartments: string[];
  /** Raw decision strings the outcome ladder in stages.ts does not recognize. */
  unmappedDecisions: string[];
  /** NetIDs that failed isNetIdShaped() and so were never attached to a row. */
  rejectedNetIds: Array<{ recordId: string; value: string }>;
};

const identityInputFrom = (
  key: string,
  identity: { firstName: string; lastName: string; email: string | null; netId: string | null },
): IdentityInput => ({
  key,
  firstName: identity.firstName,
  lastName: identity.lastName,
  email: identity.email,
  netId: identity.netId,
});

/**
 * Loads adapter output into the historical recruitment tables, idempotently.
 *
 * Every write is an upsert keyed on the row's own unique identity (netId for
 * an applicant, the three source columns for an application or interest), so
 * running this twice on unchanged input produces identical row counts, and
 * re-running after a mapping fix updates the affected rows in place rather
 * than duplicating them. This import runs repeatedly against production while
 * the mapping is tuned, so that property is the whole point.
 *
 * `dryRun: true` builds and returns the exact same report an apply run would,
 * but never opens a write: a human reads it to decide whether the mapping is
 * right before anything lands in the database.
 */
export async function loadHistory(
  rows: RawHistoryRow[],
  interests: RawInterestRow[],
  opts: { dryRun: boolean },
): Promise<ImportReport> {
  // 1. Build IdentityInput[] from every application row and interest row,
  // keyed on source.recordId so a resolved identity's memberKeys map straight
  // back to the rows that produced it.
  const identityInputs: IdentityInput[] = [
    ...rows.map((row) => identityInputFrom(row.source.recordId, row.identity)),
    ...interests.map((interest) => identityInputFrom(interest.source.recordId, interest.identity)),
  ];

  // 2. Resolve identities once, over the combined list.
  const identities = resolveIdentities(identityInputs);
  const identityByKey = new Map<string, ResolvedIdentity>();
  for (const identity of identities) {
    for (const key of identity.memberKeys) identityByKey.set(key, identity);
  }

  // Group the original rows back onto the identity they resolved to. A row
  // carrying neither an email nor a netId resolves to no identity at all
  // (resolveIdentities drops it), so it is simply not attributable to anyone
  // and is skipped here the same way.
  const rowsByIdentity = new Map<ResolvedIdentity, RawHistoryRow[]>();
  for (const row of rows) {
    const identity = identityByKey.get(row.source.recordId);
    if (!identity) continue;
    const bucket = rowsByIdentity.get(identity);
    if (bucket) bucket.push(row);
    else rowsByIdentity.set(identity, [row]);
  }
  const interestsByIdentity = new Map<ResolvedIdentity, RawInterestRow[]>();
  for (const interest of interests) {
    const identity = identityByKey.get(interest.source.recordId);
    if (!identity) continue;
    const bucket = interestsByIdentity.get(identity);
    if (bucket) bucket.push(interest);
    else interestsByIdentity.set(identity, [interest]);
  }

  // 3. Department codes, loaded once into a Set (never one lookup per row).
  const knownDepartmentCodes = new Set(
    (await prisma.department.findMany({ select: { code: true } })).map((d) => d.code),
  );

  // 4. Candidate Person rows, by netId and by contactEmail: two findMany
  // calls total, never a lookup per row.
  const candidateNetIds = [
    ...new Set(identities.map((identity) => identity.netId).filter((v): v is string => Boolean(v))),
  ];
  const candidateEmails = [...new Set(identities.flatMap((identity) => identity.emails))];
  const [personsByNetId, personsByEmail] = await Promise.all([
    prisma.person.findMany({
      where: { netId: { in: candidateNetIds } },
      select: { id: true, netId: true },
    }),
    prisma.person.findMany({
      where: { contactEmail: { in: candidateEmails } },
      select: { id: true, contactEmail: true },
    }),
  ]);
  const personIdByNetId = new Map(personsByNetId.map((p) => [p.netId!, p.id]));
  const personIdByEmail = new Map(personsByEmail.map((p) => [p.contactEmail!.toLowerCase(), p.id]));

  const resolvePersonId = (identity: ResolvedIdentity): string | null => {
    if (identity.netId) {
      const byNetId = personIdByNetId.get(identity.netId);
      if (byNetId) return byNetId;
    }
    for (const email of identity.emails) {
      const byEmail = personIdByEmail.get(email);
      if (byEmail) return byEmail;
    }
    return null;
  };

  // Build the report. This is pure computation over rows already in memory
  // and does not depend on whether anything is written, so a dry run reports
  // exactly what an apply run would have done.
  const perSourceMap = new Map<
    string,
    { rows: number; byStage: Record<string, number>; byOutcome: Record<string, number> }
  >();
  const unmappedDepartments = new Set<string>();
  const unmappedDecisions = new Set<string>();
  const rejectedNetIds: Array<{ recordId: string; value: string }> = [];

  for (const row of rows) {
    const bucket = perSourceMap.get(row.cycle.code) ?? { rows: 0, byStage: {}, byOutcome: {} };
    bucket.rows++;
    bucket.byStage[row.furthestStage] = (bucket.byStage[row.furthestStage] ?? 0) + 1;
    bucket.byOutcome[row.outcome] = (bucket.byOutcome[row.outcome] ?? 0) + 1;
    perSourceMap.set(row.cycle.code, bucket);

    // Department labels no resolver could map. Surfaced, never coerced.
    const { unmapped: unmappedChoices } = resolveDepartmentCodes(row.departmentChoicesRaw, knownDepartmentCodes);
    for (const value of unmappedChoices) unmappedDepartments.add(value);
    const trimmedResult = row.resultDepartmentRaw?.trim();
    if (trimmedResult && !resolveDepartmentCode(trimmedResult, knownDepartmentCodes)) {
      unmappedDepartments.add(trimmedResult);
    }

    // Adapters stash unrecognized decision strings and rejected NetIDs on the
    // row's own unmapped field. Collect from there; never silently drop them.
    if (row.unmapped) {
      if (typeof row.unmapped.decision === "string") unmappedDecisions.add(row.unmapped.decision);
      if (typeof row.unmapped.rejectedNetId === "string") {
        rejectedNetIds.push({ recordId: row.source.recordId, value: row.unmapped.rejectedNetId });
      }
    }
  }

  let multiCycle = 0;
  for (const memberRows of rowsByIdentity.values()) {
    const cycleCodes = new Set(memberRows.map((r) => r.cycle.code));
    if (cycleCodes.size > 1) multiCycle++;
  }

  const report: ImportReport = {
    dryRun: opts.dryRun,
    perSource: [...perSourceMap.entries()].map(([code, stats]) => ({ code, ...stats })),
    identities: { rows: identityInputs.length, resolved: identities.length, multiCycle },
    unmappedDepartments: [...unmappedDepartments],
    unmappedDecisions: [...unmappedDecisions],
    rejectedNetIds,
  };

  // 5. Dry run: return the report without ever opening a write.
  if (opts.dryRun) return report;

  // 6. Otherwise, one transaction per identity: upsert the HistoricalApplicant
  // (by netId when the identity has one, else by joining through
  // HistoricalApplicantEmail.email), upsert its emails, then upsert each
  // application and interest keyed on the three source columns.
  for (const identity of identities) {
    const memberRows = rowsByIdentity.get(identity) ?? [];
    const memberInterests = interestsByIdentity.get(identity) ?? [];
    if (memberRows.length === 0 && memberInterests.length === 0) continue;

    const personId = resolvePersonId(identity);

    await prisma.$transaction(async (tx) => {
      const existing = identity.netId
        ? await tx.historicalApplicant.findUnique({ where: { netId: identity.netId } })
        : ((
            await tx.historicalApplicantEmail.findFirst({
              where: { email: { in: identity.emails } },
              include: { applicant: true },
            })
          )?.applicant ?? null);

      const applicant = existing
        ? await tx.historicalApplicant.update({
            where: { id: existing.id },
            data: {
              primaryEmail: identity.primaryEmail,
              firstName: identity.firstName,
              lastName: identity.lastName,
              personId,
              // Never downgrade a known netId to null: an identity matched
              // purely by email in this run must not erase a stronger join
              // key a previous run already recorded.
              ...(identity.netId ? { netId: identity.netId } : {}),
            },
          })
        : await tx.historicalApplicant.create({
            data: {
              netId: identity.netId,
              primaryEmail: identity.primaryEmail,
              firstName: identity.firstName,
              lastName: identity.lastName,
              personId,
            },
          });

      for (const email of identity.emails) {
        await tx.historicalApplicantEmail.upsert({
          where: { email },
          update: { applicantId: applicant.id },
          create: { email, applicantId: applicant.id },
        });
      }

      for (const row of memberRows) {
        const { codes: departmentChoices } = resolveDepartmentCodes(row.departmentChoicesRaw, knownDepartmentCodes);
        const resultDepartment = resolveDepartmentCode(row.resultDepartmentRaw, knownDepartmentCodes);
        const sourceKey = {
          sourceBaseId: row.source.baseId,
          sourceTableId: row.source.tableId,
          sourceRecordId: row.source.recordId,
        };
        const fields = {
          cycleCode: row.cycle.code,
          cycleLabel: row.cycle.label,
          track: row.cycle.track,
          termCode: row.cycle.termCode,
          applicantType: row.applicantType,
          departmentChoices,
          resultDepartment,
          furthestStage: row.furthestStage,
          outcome: row.outcome,
          submittedAt: row.submittedAt,
          decidedAt: row.decidedAt,
          // A nullable Json column: Prisma.DbNull, not plain null, clears it.
          unmappedNotes: (row.unmapped as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
        };
        await tx.historicalApplication.upsert({
          where: { sourceBaseId_sourceTableId_sourceRecordId: sourceKey },
          update: fields,
          create: { applicantId: applicant.id, ...sourceKey, ...fields },
        });
      }

      for (const interest of memberInterests) {
        const sourceKey = {
          sourceBaseId: interest.source.baseId,
          sourceTableId: interest.source.tableId,
          sourceRecordId: interest.source.recordId,
        };
        await tx.historicalInterest.upsert({
          where: { sourceBaseId_sourceTableId_sourceRecordId: sourceKey },
          update: { submittedAt: interest.submittedAt },
          create: { applicantId: applicant.id, ...sourceKey, submittedAt: interest.submittedAt },
        });
      }
    });
  }

  return report;
}
