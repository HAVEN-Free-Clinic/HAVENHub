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
  /**
   * Count of archived interest-form rows. Interest rows have no cycle code of
   * their own (see INTEREST_CYCLE in history.ts), so they never appear in
   * `perSource` above; without this field the dry-run report a human reads
   * before authorizing a write has no visibility into them at all.
   */
  interestRows: number;
  identities: { rows: number; resolved: number; multiCycle: number };
  /**
   * Count of pre-existing HistoricalApplicant rows collapsed into a single
   * survivor because a later row proved they were the same person (one
   * matched by netId, the other by email, until one row carried both keys).
   * Always 0 on a dry run, since a dry run performs no merges.
   */
  identitiesMerged: number;
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
 * The identity key for one source row, namespaced to the source it came
 * from. Airtable base duplication PRESERVES record ids (this is how D-WN26
 * was identified as a clone of D-FA25, holding "the same 89 record ids"), so
 * `recordId` alone is not unique across sources: if two included sources
 * ever shared a bare record id, both rows would collapse onto the same
 * union-find node in identity.ts and TWO DIFFERENT PEOPLE would be written
 * as a single HistoricalApplicant with both their emails attached. Keying on
 * the full (baseId, tableId, recordId) triple keeps rows from different
 * sources apart no matter what their record ids look like.
 */
const identityKeyFor = (source: { baseId: string; tableId: string; recordId: string }): string =>
  `${source.baseId}:${source.tableId}:${source.recordId}`;

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
  // keyed on identityKeyFor(source) so a resolved identity's memberKeys map
  // straight back to the rows that produced it.
  const identityInputs: IdentityInput[] = [
    ...rows.map((row) => identityInputFrom(identityKeyFor(row.source), row.identity)),
    ...interests.map((interest) => identityInputFrom(identityKeyFor(interest.source), interest.identity)),
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
    const identity = identityByKey.get(identityKeyFor(row.source));
    if (!identity) continue;
    const bucket = rowsByIdentity.get(identity);
    if (bucket) bucket.push(row);
    else rowsByIdentity.set(identity, [row]);
  }
  const interestsByIdentity = new Map<ResolvedIdentity, RawInterestRow[]>();
  for (const interest of interests) {
    const identity = identityByKey.get(identityKeyFor(interest.source));
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
    interestRows: interests.length,
    identities: { rows: identityInputs.length, resolved: identities.length, multiCycle },
    unmappedDepartments: [...unmappedDepartments],
    unmappedDecisions: [...unmappedDecisions],
    rejectedNetIds,
    identitiesMerged: 0,
  };

  // 5. Dry run: return the report without ever opening a write.
  if (opts.dryRun) return report;

  // 6. Otherwise, one transaction per identity: find or create the
  // HistoricalApplicant, upsert its emails, then upsert each application and
  // interest keyed on the three source columns.
  //
  // The applicant lookup gathers candidates from BOTH keys (netId and the
  // emails relation) rather than branching to just one. A row can arrive with
  // an email but no netId, get an applicant created for it, and only later
  // have its netId filled in (by ops, or by a second row for the same
  // person). Branching exclusively on "netId present" would then miss the
  // existing email-matched applicant, create a second one, and silently move
  // the email to it while every previously-imported application stayed
  // attached to the orphaned original. Gathering both and reconciling makes
  // that case a one-candidate match (adopt the netId) instead of a silent
  // split, and makes the rarer two-candidate case (two already-distinct
  // applicants a later row proves are the same person) an explicit, counted
  // merge rather than an arbitrary pick.
  let totalMerges = 0;
  for (const identity of identities) {
    const memberRows = rowsByIdentity.get(identity) ?? [];
    const memberInterests = interestsByIdentity.get(identity) ?? [];
    if (memberRows.length === 0 && memberInterests.length === 0) continue;

    const personId = resolvePersonId(identity);

    // ONLY applicant resolution and the merge run inside a transaction, and
    // that boundary is load-bearing rather than stylistic.
    //
    // The merge re-points three relations off each duplicate and then deletes
    // it. Those relations cascade-delete from HistoricalApplicant, so a
    // half-applied merge destroys history. That genuinely needs atomicity.
    //
    // The bulk upserts below do NOT, because every one is keyed on a natural
    // key (the email, or the source triple) and is idempotent, so a crash
    // partway leaves rows a re-run simply corrects.
    //
    // Keeping them inside cost us a real production failure: each upsert is a
    // separate round trip, and Prisma's interactive transactions default to a
    // 5s budget. Against local Postgres a dozen round trips take about 2ms;
    // against Neon they take seconds. The first production run died at
    // 11,682ms on one identity, after 93 had already committed. Every local
    // test passed, because localhost latency is roughly 1000x lower.
    //
    // Do not move the loops back inside this transaction.
    const applicant = await prisma.$transaction(async (tx) => {
      const candidateIds = new Set<string>();
      if (identity.netId) {
        const byNetId = await tx.historicalApplicant.findUnique({ where: { netId: identity.netId } });
        if (byNetId) candidateIds.add(byNetId.id);
      }
      const emailMatches = await tx.historicalApplicantEmail.findMany({
        where: { email: { in: identity.emails } },
        select: { applicantId: true },
      });
      for (const match of emailMatches) candidateIds.add(match.applicantId);

      let resolved;
      if (candidateIds.size === 0) {
        resolved = await tx.historicalApplicant.create({
          data: {
            netId: identity.netId,
            primaryEmail: identity.primaryEmail,
            firstName: identity.firstName,
            lastName: identity.lastName,
            personId,
          },
        });
      } else {
        const candidates = await tx.historicalApplicant.findMany({
          where: { id: { in: [...candidateIds] } },
          include: { _count: { select: { applications: true } } },
        });

        // Survivor: most applications, ties broken by earliest createdAt.
        // Deterministic so a re-run always picks the same survivor.
        const [survivor, ...duplicates] = candidates.sort((a, b) => {
          if (b._count.applications !== a._count.applications) {
            return b._count.applications - a._count.applications;
          }
          return a.createdAt.getTime() - b.createdAt.getTime();
        });

        // Re-point everything off each duplicate BEFORE deleting it: both
        // HistoricalApplication and HistoricalApplicantEmail cascade-delete
        // from HistoricalApplicant, so deleting first would destroy the very
        // history and join keys this merge exists to preserve.
        for (const duplicate of duplicates) {
          await tx.historicalApplication.updateMany({
            where: { applicantId: duplicate.id },
            data: { applicantId: survivor.id },
          });
          await tx.historicalInterest.updateMany({
            where: { applicantId: duplicate.id },
            data: { applicantId: survivor.id },
          });
          await tx.historicalApplicantEmail.updateMany({
            where: { applicantId: duplicate.id },
            data: { applicantId: survivor.id },
          });
          await tx.historicalApplicant.delete({ where: { id: duplicate.id } });
          totalMerges++;
        }

        resolved = await tx.historicalApplicant.update({
          where: { id: survivor.id },
          data: {
            primaryEmail: identity.primaryEmail,
            firstName: identity.firstName,
            lastName: identity.lastName,
            personId,
            // Never downgrade a known netId to null: an identity matched
            // purely by email in this run must not erase a stronger join
            // key a previous run already recorded. Duplicates carrying the
            // netId are already deleted above, so this can never collide.
            ...(identity.netId ? { netId: identity.netId } : {}),
          },
        });
      }

      return resolved;
      // The merge does a handful of round trips per duplicate, so give it more
      // than the 5s default. It is bounded by the number of duplicates, which
      // is normally zero and never large.
    }, { timeout: 20_000 });

    for (const email of identity.emails) {
      await prisma.historicalApplicantEmail.upsert({
        where: { email },
        update: { applicantId: applicant.id },
        create: { email, applicantId: applicant.id },
      });
    }

    {
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
        await prisma.historicalApplication.upsert({
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
        await prisma.historicalInterest.upsert({
          where: { sourceBaseId_sourceTableId_sourceRecordId: sourceKey },
          update: { submittedAt: interest.submittedAt },
          create: { applicantId: applicant.id, ...sourceKey, submittedAt: interest.submittedAt },
        });
      }
    }
  }

  report.identitiesMerged = totalMerges;
  return report;
}
