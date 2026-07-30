/**
 * Imports a CLOSED term's roster from Airtable as institutional history.
 *
 * This is deliberately a separate path from runImport (importer.ts), which
 * imports the roster of the term the clinic is currently running. The two
 * differ in one load-bearing way:
 *
 *   runImport must never resurrect an offboarded member, so it refuses to
 *   CREATE a membership for anyone whose Person.status is not ACTIVE.
 *
 *   This import exists precisely to record people who have since been
 *   offboarded -- a past term's roster is a statement about who served then,
 *   not about who has access now -- so it applies no such guard.
 *
 * That is only safe because the term is ARCHIVED. Every permission-, roster-,
 * schedule- and compliance-bearing query in the app scopes its TermMembership
 * lookups to the ACTIVE term (see rbac/engine.ts, departments.ts,
 * rbac/holders.ts, rbac/last-admin.ts, compliance/access.ts, and the schedule
 * services), and getPersonTerms() explicitly excludes ARCHIVED terms from the
 * member-facing term switcher. An ACTIVE membership in an ARCHIVED term is
 * therefore inert: it reads as "this person served this term" and grants
 * nothing. To keep that invariant true, this import
 *
 *   - creates the term ARCHIVED and never activates it, and
 *   - REFUSES to run against a term that is ACTIVE or PLANNING,
 *
 * so it can never be pointed at a live roster, where the missing offboard
 * guard would silently put removed members back on it.
 *
 * The import never deletes; re-running it is a no-op on rows that already exist.
 */

import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { transformRoster } from "./transforms";
import type { AirtableReader } from "./importer";
import type { RosterFieldIds } from "../fields";

export type HistoricalTermSpec = {
  /** Term code, e.g. "SP26". Unique; matched case-sensitively. */
  code: string;
  /** Display name, e.g. "Spring 2026". Set only when the term is created. */
  name: string;
  startDate: Date;
  endDate: Date;
};

export type HistoricalTermImportOptions = {
  baseId: string;
  rosterTableId: string;
  rosterFields: RosterFieldIds;
  term: HistoricalTermSpec;
  dryRun: boolean;
};

export type HistoricalTermImportReport = {
  dryRun: boolean;
  term: { code: string; created: boolean };
  departments: { created: number; existing: number };
  memberships: { created: number; existing: number };
  /**
   * Roster links whose Airtable record id matches no Person. Expected to be
   * empty after a full people import; anything here means a roster row points
   * at an All People record that was never imported.
   */
  unresolvedPeople: Array<{ recordId: string; departmentCode: string; kind: Track }>;
};

/** Thrown instead of writing when the target term is not safe to treat as history. */
export class HistoricalTermNotArchivedError extends Error {
  constructor(code: string, status: string) {
    super(
      `Term ${code} is ${status}, not ARCHIVED. The historical-term import applies no ` +
        `offboard guard and would put removed members back on a live roster. Archive the ` +
        `term first, or use the regular import for the running term.`,
    );
    this.name = "HistoricalTermNotArchivedError";
  }
}

export async function runHistoricalTermImport(
  reader: AirtableReader,
  options: HistoricalTermImportOptions,
): Promise<HistoricalTermImportReport> {
  const { term: spec } = options;
  const rosterRecords = await reader.listAll(options.baseId, options.rosterTableId);
  const roster = transformRoster(rosterRecords, options.rosterFields);

  // Dedupe: a person linked twice into the same department+kind is one membership.
  const links = [
    ...new Map(
      roster.memberships.map((m) => [`${m.personRecordId}|${m.departmentCode}|${m.kind}`, m]),
    ).values(),
  ];
  const departmentCodes = [...new Set(roster.departments.map((d) => d.code))];

  const existingTerm = await prisma.term.findUnique({ where: { code: spec.code } });
  // Safety rail, checked in dry-run too so the operator finds out before --apply.
  if (existingTerm && existingTerm.status !== "ARCHIVED") {
    throw new HistoricalTermNotArchivedError(spec.code, existingTerm.status);
  }

  const personIdByRecordId = new Map(
    (
      await prisma.person.findMany({
        where: { airtableRecordId: { in: links.map((l) => l.personRecordId) } },
        select: { id: true, airtableRecordId: true },
      })
    ).map((p) => [p.airtableRecordId!, p.id]),
  );

  const unresolvedPeople = links
    .filter((l) => !personIdByRecordId.has(l.personRecordId))
    .map((l) => ({ recordId: l.personRecordId, departmentCode: l.departmentCode, kind: l.kind }));

  const existingDepartmentCodes = new Set(
    (
      await prisma.department.findMany({
        where: { code: { in: departmentCodes } },
        select: { code: true },
      })
    ).map((d) => d.code),
  );

  const report: HistoricalTermImportReport = {
    dryRun: options.dryRun,
    term: { code: spec.code, created: !existingTerm },
    departments: {
      created: departmentCodes.filter((c) => !existingDepartmentCodes.has(c)).length,
      existing: departmentCodes.filter((c) => existingDepartmentCodes.has(c)).length,
    },
    memberships: { created: 0, existing: 0 },
    unresolvedPeople,
  };

  const resolvedLinks = links.filter((l) => personIdByRecordId.has(l.personRecordId));

  if (options.dryRun) {
    // Count only what apply would actually create. Without an existing term
    // nothing can already be there; with one, check the compound key.
    if (!existingTerm) {
      report.memberships.created = resolvedLinks.length;
      return report;
    }
    const departmentIdByCode = new Map(
      (
        await prisma.department.findMany({
          where: { code: { in: departmentCodes } },
          select: { id: true, code: true },
        })
      ).map((d) => [d.code, d.id]),
    );
    const present = new Set(
      (
        await prisma.termMembership.findMany({
          where: { termId: existingTerm.id },
          select: { personId: true, departmentId: true, kind: true },
        })
      ).map((m) => `${m.personId}|${m.departmentId}|${m.kind}`),
    );
    for (const link of resolvedLinks) {
      const departmentId = departmentIdByCode.get(link.departmentCode);
      const key = `${personIdByRecordId.get(link.personRecordId)}|${departmentId}|${link.kind}`;
      if (departmentId && present.has(key)) report.memberships.existing++;
      else report.memberships.created++;
    }
    return report;
  }

  const term =
    existingTerm ??
    (await prisma.term.create({
      data: {
        code: spec.code,
        name: spec.name,
        startDate: spec.startDate,
        endDate: spec.endDate,
        // ARCHIVED from birth: this term is history, never a term the app runs.
        // activateTerm() is the only supported way to make a term ACTIVE and it
        // is never called here.
        status: "ARCHIVED",
      },
    }));

  for (const code of departmentCodes) {
    await prisma.department.upsert({
      where: { code },
      // Never overwrite an existing department's name -- admins customize it in
      // the app and the import default is just the code (mirrors runImport).
      update: {},
      create: { code, name: code },
    });
  }
  const departmentIdByCode = new Map(
    (
      await prisma.department.findMany({
        where: { code: { in: departmentCodes } },
        select: { id: true, code: true },
      })
    ).map((d) => [d.code, d.id]),
  );

  const rows = resolvedLinks
    .map((link) => ({
      personId: personIdByRecordId.get(link.personRecordId)!,
      termId: term.id,
      departmentId: departmentIdByCode.get(link.departmentCode),
      kind: link.kind,
      status: "ACTIVE" as const,
    }))
    // A roster row with no department code never produces links (transformRoster
    // skips it), so this only guards against an upsert that somehow did not land.
    .filter((r): r is typeof r & { departmentId: string } => Boolean(r.departmentId));

  // skipDuplicates keys off the personId_termId_departmentId_kind unique index,
  // so a row that already exists is left EXACTLY as it is -- including one an
  // admin has since marked REMOVED, which is a deliberate correction to the
  // historical record that a re-import must not undo.
  const { count } = await prisma.termMembership.createMany({ data: rows, skipDuplicates: true });
  report.memberships.created = count;
  report.memberships.existing = rows.length - count;

  return report;
}
