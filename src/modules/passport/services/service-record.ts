/**
 * The volunteer service record: one computation, three renderings.
 *
 * This is the only place that decides what a member's service history IS.
 * The PDF, the public credential page, and the wallet pass all render a
 * SNAPSHOT of this value (see credential.ts), never a fresh computation, so
 * they cannot drift apart or surface a record the member never published.
 *
 * Two data limits shape the output and must not be papered over:
 *
 *   1. ShiftAssignment rows begin at the SU26 cutover import. A term with no
 *      shift data at all yields `shifts: null`; a term that HAS data where this
 *      member held none yields `shifts: 0`. Rendering those identically would
 *      claim a member did nothing when the truth is that we were not counting.
 *      Whether a term has data is PROBED, never hardcoded, so the boundary
 *      moves on its own if anyone backfills.
 *
 *   2. TermMembership rows begin at SP26. Earlier service is reconstructed from
 *      HistoricalApplication rows that reached ONBOARDED + ACCEPTED, which is
 *      evidence of joining, not of duration. Those rows always carry
 *      `shifts: null` and are marked `source: "RECRUITMENT"` so the renderer can
 *      label them honestly.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/platform/db";

/** Either the singleton client or a transaction client, so the offboard hook can snapshot in-transaction. */
export type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

export type ServiceTermRow = {
  termCode: string;
  termName: string;
  /** ISO string. JSON-safe: this value crosses into client components. */
  startDate: string;
  departmentName: string;
  track: "VOLUNTEER" | "DIRECTOR";
  /** null = the term has no shift records at all. 0 = it does, and this member had none. */
  shifts: number | null;
  source: "MEMBERSHIP" | "RECRUITMENT";
};

export type ServiceRecord = {
  name: string;
  /** Null when the person has no membership and no onboarded recruitment outcome. */
  memberSince: { label: string; source: "MEMBERSHIP" | "RECRUITMENT" } | null;
  /** Ascending by term start. */
  terms: ServiceTermRow[];
  capabilities: { spanishVerified: boolean; licensedRN: boolean };
  /** Upgrades to "ATTENDED" only if attendance capture is ever built. */
  basis: "SCHEDULED";
  generatedAt: string;
};

export async function computeServiceRecord(
  personId: string,
  client: PrismaClientOrTx = prisma,
): Promise<ServiceRecord> {
  const person = await client.person.findUnique({
    where: { id: personId },
    select: { name: true, spanishVerified: true, licensedRN: true },
  });
  if (!person) throw new Error(`No person ${personId}`);

  const memberships = await client.termMembership.findMany({
    where: { personId, status: "ACTIVE" },
    select: {
      kind: true,
      department: { select: { name: true } },
      term: { select: { id: true, code: true, name: true, startDate: true } },
    },
  });

  const termIds = memberships.map((m) => m.term.id);

  // Which of these terms have ANY shift data, for anyone. This is the probe that
  // keeps the SU26 boundary out of the code.
  const termsWithData = new Set(
    termIds.length === 0
      ? []
      : (
          await client.shiftAssignment.groupBy({
            by: ["termId"],
            where: { termId: { in: termIds } },
          })
        ).map((row) => row.termId),
  );

  const ownCounts = new Map(
    termIds.length === 0
      ? []
      : (
          await client.shiftAssignment.groupBy({
            by: ["termId"],
            where: { personId, termId: { in: termIds } },
            _count: { _all: true },
          })
        ).map((row) => [row.termId, row._count._all] as const),
  );

  const membershipRows: ServiceTermRow[] = memberships.map((m) => ({
    termCode: m.term.code,
    termName: m.term.name,
    startDate: m.term.startDate.toISOString(),
    departmentName: m.department.name,
    track: m.kind,
    shifts: termsWithData.has(m.term.id) ? (ownCounts.get(m.term.id) ?? 0) : null,
    source: "MEMBERSHIP" as const,
  }));

  const covered = new Set(membershipRows.map((r) => r.termCode));

  // Pre-roster service, reconstructed from recruitment outcomes. Only an
  // ONBOARDED + ACCEPTED row means the person actually joined; anything short of
  // that is an application, not service.
  const historical = await client.historicalApplication.findMany({
    where: {
      applicant: { personId },
      furthestStage: "ONBOARDED",
      outcome: "ACCEPTED",
    },
    select: {
      cycleCode: true,
      cycleLabel: true,
      termCode: true,
      resultDepartment: true,
      track: true,
      decidedAt: true,
      submittedAt: true,
    },
  });

  // resultDepartment is a department CODE resolved at import time. The department
  // may since have been renamed or retired, so fall back to the raw code rather
  // than dropping the row or inventing a name.
  const codes = historical.map((h) => h.resultDepartment).filter((c): c is string => Boolean(c));
  const departmentNames = new Map(
    codes.length === 0
      ? []
      : (
          await client.department.findMany({
            where: { code: { in: codes } },
            select: { code: true, name: true },
          })
        ).map((d) => [d.code, d.name] as const),
  );

  const recruitmentRows: ServiceTermRow[] = [];
  for (const h of historical) {
    const code = h.termCode ?? h.cycleCode;
    if (covered.has(code)) continue; // A roster row for this term wins.
    // Without a date we cannot place the row in time, and an unplaceable row
    // would sort unpredictably against real terms. Skip rather than guess.
    const anchor = h.decidedAt ?? h.submittedAt;
    if (!anchor) continue;
    covered.add(code);
    recruitmentRows.push({
      termCode: code,
      termName: h.cycleLabel,
      startDate: anchor.toISOString(),
      departmentName: h.resultDepartment
        ? (departmentNames.get(h.resultDepartment) ?? h.resultDepartment)
        : "Department not recorded",
      track: h.track,
      shifts: null,
      source: "RECRUITMENT",
    });
  }

  const terms = [...membershipRows, ...recruitmentRows].sort((a, b) =>
    a.startDate.localeCompare(b.startDate),
  );

  // Derived from the first row rather than computed separately, so the headline
  // and the table can never disagree about when service began.
  const first = terms[0];

  return {
    name: person.name,
    memberSince: first ? { label: first.termName, source: first.source } : null,
    terms,
    capabilities: {
      spanishVerified: person.spanishVerified,
      licensedRN: person.licensedRN,
    },
    basis: "SCHEDULED",
    generatedAt: new Date().toISOString(),
  };
}
