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
 *   1. ShiftAssignment rows begin at the SU26 cutover import. A term-and-
 *      department with no shift data at all yields `shifts: null`; one that HAS
 *      data where this member held none yields `shifts: 0`. Rendering those
 *      identically would claim a member did nothing when the truth is that we
 *      were not counting. Whether the data exists is PROBED, never hardcoded, so
 *      the boundary moves on its own if anyone backfills.
 *
 *   2. TermMembership rows begin at SP26. Earlier service is reconstructed from
 *      HistoricalApplication rows that reached ONBOARDED + ACCEPTED, which is
 *      evidence of joining, not of duration. Those rows always carry
 *      `shifts: null` and are marked `source: "RECRUITMENT"` so the renderer can
 *      label them honestly.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/platform/db";

/**
 * Either the singleton client or a transaction client.
 *
 * The offboard hook deliberately does NOT pass a transaction client: it calls
 * issueServiceCredential against the singleton, outside its own transaction
 * (see the long comment in src/platform/people.ts). Do not "restore" an
 * in-transaction snapshot on the strength of this type: a failed audit write on
 * a transaction client poisons the caller's transaction and rolls the offboard
 * back. The parameter exists for callers that already own a transaction and
 * want the snapshot to share it.
 */
export type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

export type ServiceTermRow = {
  termCode: string;
  termName: string;
  /** ISO string. JSON-safe: this value crosses into client components. */
  startDate: string;
  departmentName: string;
  track: "VOLUNTEER" | "DIRECTOR";
  /**
   * null = this term and department have no shift records at all. 0 = they do,
   * and this member had none there.
   */
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

/**
 * A term and department with no shift records must never read as a zero. "Not
 * recorded" says the clinic was not counting; "0 scheduled" says the member
 * held no shifts.
 * Collapsing the two would understate a long-serving member on a document that
 * goes to residency programs.
 *
 * Lives here, next to ServiceTermRow, rather than in the PDF renderer: the
 * certificate PDF and the public credential page both format this value and
 * must never disagree about how it reads, and importing it from the PDF
 * module would pull @react-pdf/renderer (no sideEffects: false) into the
 * public page's server bundle for a two-line string helper.
 */
export function formatShifts(shifts: number | null): string {
  return shifts === null ? "Not recorded" : `${shifts} scheduled`;
}

/** Human label for a term row's track. Same reuse rationale as formatShifts above. */
export function trackLabel(track: ServiceTermRow["track"]): string {
  return track === "DIRECTOR" ? "Director" : "Volunteer";
}

export async function computeServiceRecord(
  personId: string,
  client: PrismaClientOrTx = prisma,
): Promise<ServiceRecord> {
  const person = await client.person.findUnique({
    where: { id: personId },
    select: { name: true, spanishVerified: true, licensedRN: true },
  });
  if (!person) throw new Error(`No person ${personId}`);

  // A term that has not started yet is not service. This clinic deliberately
  // rosters the next term ahead of the ACTIVE flip (see the comment in
  // src/platform/offboarding/self-withdrawal.ts), so an incoming director holds
  // a PLANNING-term membership before serving a day, and without this filter it
  // would print on their certificate under a footer that explains "Not
  // recorded" as PREDATING the clinic's records. Safe for the offboard
  // snapshot: that path targets the ACTIVE term, which has already started.
  const memberships = await client.termMembership.findMany({
    where: { personId, status: "ACTIVE", term: { startDate: { lte: new Date() } } },
    select: {
      kind: true,
      departmentId: true,
      department: { select: { name: true } },
      term: { select: { id: true, code: true, name: true, startDate: true } },
    },
  });

  const termIds = [...new Set(memberships.map((m) => m.term.id))];
  const departmentIds = [...new Set(memberships.map((m) => m.departmentId))];

  // Shift counts are keyed by (term, department), NOT by term alone. The
  // membership unique key is (person, term, department, kind), so one member can
  // hold rows in several departments in one term; a term-grained count attached
  // to every row would print the term total against each department and show a
  // member 8 + 6 shifts as "14 scheduled" twice.
  const key = (termId: string, departmentId: string) => `${termId}::${departmentId}`;

  const noProbe = termIds.length === 0 || departmentIds.length === 0;
  const probeWhere = { termId: { in: termIds }, departmentId: { in: departmentIds } };

  // Which of these term-and-department pairs have ANY shift data, for anyone.
  // This is the probe that keeps the SU26 boundary out of the code.
  const pairsWithData = new Set(
    noProbe
      ? []
      : (
          await client.shiftAssignment.groupBy({
            by: ["termId", "departmentId"],
            where: probeWhere,
          })
        ).map((row) => key(row.termId, row.departmentId)),
  );

  const ownCounts = new Map(
    noProbe
      ? []
      : (
          await client.shiftAssignment.groupBy({
            by: ["termId", "departmentId"],
            where: { personId, ...probeWhere },
            _count: { _all: true },
          })
        ).map((row) => [key(row.termId, row.departmentId), row._count._all] as const),
  );

  // At most one row per (term, department) reaches the output. `kind` is part of
  // the membership unique key, so a member can hold BOTH a VOLUNTEER and a
  // DIRECTOR row for the same term and department; emitting both would print the
  // department twice and attach the same shift count to each. DIRECTOR wins as
  // the senior role, so the certificate reports the higher standing the member
  // actually held.
  const byTermDepartment = new Map<string, ServiceTermRow>();
  for (const m of memberships) {
    const pair = key(m.term.id, m.departmentId);
    const existing = byTermDepartment.get(pair);
    if (existing && !(m.kind === "DIRECTOR" && existing.track !== "DIRECTOR")) continue;
    byTermDepartment.set(pair, {
      termCode: m.term.code,
      termName: m.term.name,
      startDate: m.term.startDate.toISOString(),
      departmentName: m.department.name,
      track: m.kind,
      shifts: pairsWithData.has(pair) ? (ownCounts.get(pair) ?? 0) : null,
      source: "MEMBERSHIP" as const,
    });
  }
  const membershipRows = [...byTermDepartment.values()];

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

  // Department breaks the tie: a member in two departments in one term produces
  // two rows with an identical startDate, and the membership query has no
  // ordering of its own, so without this the two rows would swap places between
  // renders of the same frozen record.
  const terms = [...membershipRows, ...recruitmentRows].sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) || a.departmentName.localeCompare(b.departmentName),
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
