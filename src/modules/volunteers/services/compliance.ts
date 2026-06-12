/**
 * Volunteers module compliance service.
 *
 * Services trust callers for authentication; permission checks live at the
 * page/action layer. No N+1 queries: memberships are fetched with person + their
 * certs via include, then cert selection is done in JS.
 */

import type { Department, HipaaCertificate, Person } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { complianceStatus, overallClearance } from "@/platform/compliance/rules";
import type { ComplianceStatus, TrainingState, OverallClearance } from "@/platform/compliance/rules";
import { canViewCertificate } from "@/platform/compliance/access";
import { manageableDepartmentIds } from "@/platform/departments";
import { can } from "@/platform/rbac/engine";
import { enqueueMirror } from "@/platform/outbox";
import { parseCompletionDate, CompletionDateError } from "@/platform/compliance/completion-date";

export type { ComplianceStatus };

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class CertificateNotFoundError extends Error {
  constructor(certId: string) {
    super(`Certificate not found: ${certId}`);
    this.name = "CertificateNotFoundError";
  }
}

export class ComplianceForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplianceForbiddenError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemberCompliance = {
  person: Person;
  kind: "DIRECTOR" | "VOLUNTEER";
  cert: HipaaCertificate | null;
  status: ComplianceStatus;
  verifiedByName: string | null;
  trainingState: TrainingState;
  overallClearance: OverallClearance;
};

type DepartmentCompliance = {
  department: Department;
  members: MemberCompliance[];
  counts: Record<ComplianceStatus, number>;
};

// ---------------------------------------------------------------------------
// Status sort order: non-compliant first
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<ComplianceStatus, number> = {
  NO_CERTIFICATE: 0,
  EXPIRED: 1,
  UNKNOWN_DATE: 2,
  EXPIRING_SOON: 3,
  COMPLIANT: 4,
};

// ---------------------------------------------------------------------------
// departmentCompliance
// ---------------------------------------------------------------------------

/**
 * Returns compliance data for all departments the viewer manages: departments
 * where they hold an ACTIVE DIRECTOR membership in the active term, plus the
 * departments those manage via DepartmentDelegation (one hop). A PCAR director
 * therefore sees PCAR + SCTP + JCTP cards. Delegation is one-way.
 *
 * For each department:
 *   - members: ALL ACTIVE memberships (both DIRECTOR and VOLUNTEER), each with
 *     their newest cert and computed compliance status.
 *   - counts: per-status totals.
 *   - members are sorted: non-compliant statuses first (NO_CERTIFICATE, EXPIRED,
 *     UNKNOWN_DATE, EXPIRING_SOON, COMPLIANT), then alphabetically by name.
 */
export async function departmentCompliance(
  viewerPersonId: string
): Promise<DepartmentCompliance[]> {
  // 1. Find the active term.
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  if (!activeTerm) return [];

  // 2. Departments the viewer manages: own active directorships PLUS one-hop
  //    delegations. Returns [] when there is no active term or no directorships.
  const deptIds = await manageableDepartmentIds(viewerPersonId);
  if (deptIds.length === 0) return [];

  // Resolve the Department rows (used for card headings + stable ordering).
  const departments = await prisma.department.findMany({
    where: { id: { in: deptIds } },
    orderBy: { code: "asc" },
  });

  // 3. Fetch all ACTIVE memberships in those departments (both kinds), with
  //    person + their certs, in one query.
  const memberships = await prisma.termMembership.findMany({
    where: {
      termId: activeTerm.id,
      departmentId: { in: deptIds },
      status: "ACTIVE",
    },
    include: {
      person: {
        include: {
          hipaaCertificates: {
            orderBy: { uploadedAt: "desc" },
          },
        },
      },
    },
  });

  // 4. Collect distinct non-null verifiedById values and resolve to names in one query.
  const verifierIds = Array.from(
    new Set(
      memberships.flatMap((m) =>
        m.person.hipaaCertificates
          .slice(0, 1) // only the newest cert per person
          .map((c) => c.verifiedById)
          .filter((id): id is string => id !== null)
      )
    )
  );

  const verifierNameMap = new Map<string, string>();
  if (verifierIds.length > 0) {
    const verifiers = await prisma.person.findMany({
      where: { id: { in: verifierIds } },
      select: { id: true, name: true },
    });
    for (const v of verifiers) {
      if (v.name) verifierNameMap.set(v.id, v.name);
    }
  }

  // 5. Fetch the set of people with COMPLETE training for the active term once.
  const completedTraining = new Set(
    (await prisma.volunteerTraining.findMany({
      where: { termId: activeTerm.id, status: "COMPLETE" },
      select: { personId: true },
    })).map((t) => t.personId)
  );

  // 6. Group by department and compute per-member compliance.
  const deptMap = new Map<string, { department: Department; members: MemberCompliance[] }>();

  // Ensure we have an entry for every manageable department, in code order.
  for (const d of departments) {
    if (!deptMap.has(d.id)) {
      deptMap.set(d.id, { department: d, members: [] });
    }
  }

  for (const m of memberships) {
    const entry = deptMap.get(m.departmentId);
    if (!entry) continue; // should never happen given the query filter

    const certs = m.person.hipaaCertificates;
    // Newest cert = first in the descending-uploadedAt list.
    const newestCert: HipaaCertificate | null = certs.length > 0 ? certs[0] : null;

    const status = complianceStatus(
      newestCert
        ? { completionDate: newestCert.completionDate }
        : null,
      activeTerm.endDate
    );

    const verifiedByName = newestCert?.verifiedById
      ? (verifierNameMap.get(newestCert.verifiedById) ?? null)
      : null;

    const trainingState: TrainingState = completedTraining.has(m.person.id) ? "COMPLETE" : "PENDING";
    entry.members.push({
      person: m.person,
      kind: m.kind,
      cert: newestCert,
      status,
      verifiedByName,
      trainingState,
      overallClearance: overallClearance(status, trainingState),
    });
  }

  // 6. Sort members and build counts per department.
  const result: DepartmentCompliance[] = [];

  for (const { department, members } of deptMap.values()) {
    // Sort: status order first, then name alphabetically.
    members.sort((a, b) => {
      const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (statusDiff !== 0) return statusDiff;
      return a.person.name.localeCompare(b.person.name);
    });

    // Build counts.
    const counts: Record<ComplianceStatus, number> = {
      COMPLIANT: 0,
      EXPIRING_SOON: 0,
      EXPIRED: 0,
      UNKNOWN_DATE: 0,
      NO_CERTIFICATE: 0,
    };
    for (const m of members) {
      counts[m.status]++;
    }

    result.push({ department, members, counts });
  }

  return result;
}

// ---------------------------------------------------------------------------
// masterCompliance
// ---------------------------------------------------------------------------

export type MasterQuery = {
  status?: ComplianceStatus;
  departmentId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
};

/**
 * The master view is one row per PERSON, not per membership, so it does not
 * carry a membership `kind`. Omitting it (rather than using a placeholder) keeps
 * the type honest -- the master table never displays a director/volunteer badge.
 */
export type MasterComplianceRow = Omit<MemberCompliance, "kind"> & {
  departments: string[];
};

export type MasterComplianceResult = {
  rows: MasterComplianceRow[];
  total: number;
  page: number;
  pageCount: number;
  summary: Record<ComplianceStatus, number>;
};

const EMPTY_SUMMARY: Record<ComplianceStatus, number> = {
  COMPLIANT: 0,
  EXPIRING_SOON: 0,
  EXPIRED: 0,
  UNKNOWN_DATE: 0,
  NO_CERTIFICATE: 0,
};

/**
 * Returns compliance data for ALL active people with at least one ACTIVE
 * membership in the active term. One row per PERSON (not per membership).
 *
 * The summary counts are computed over the FULL filtered-by-q/departmentId
 * scope BEFORE the status filter, so the count chips always show the whole
 * picture for the current search/department scope. The status filter then
 * narrows which rows are returned and what total/pageCount reflect.
 *
 * Pagination uses pageSize 25 by default. Page is 1-based.
 */
export async function masterCompliance(
  query: MasterQuery
): Promise<MasterComplianceResult> {
  const { status, departmentId, q, page = 1, pageSize = 25 } = query;

  // 1. Find the active term.
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });

  if (!activeTerm) {
    return {
      rows: [],
      total: 0,
      page: 1,
      pageCount: 0,
      summary: { ...EMPTY_SUMMARY },
    };
  }

  // 2. Fetch ALL ACTIVE memberships in the active term (optionally narrowed by
  //    departmentId), with person + their certs, in one query.
  const memberships = await prisma.termMembership.findMany({
    where: {
      termId: activeTerm.id,
      status: "ACTIVE",
      ...(departmentId ? { departmentId } : {}),
    },
    include: {
      department: true,
      person: {
        include: {
          hipaaCertificates: {
            orderBy: { uploadedAt: "desc" },
          },
        },
      },
    },
  });

  // 2b. Fetch the set of people with COMPLETE training for the active term once.
  const completedTraining = new Set(
    (await prisma.volunteerTraining.findMany({
      where: { termId: activeTerm.id, status: "COMPLETE" },
      select: { personId: true },
    })).map((t) => t.personId)
  );

  // 3. Deduplicate by person: one row per person, accumulating dept codes.
  //    personMap: personId -> { person, certs, deptCodes }
  const personMap = new Map<
    string,
    {
      person: Person & { hipaaCertificates: HipaaCertificate[] };
      deptCodes: Set<string>;
    }
  >();

  for (const m of memberships) {
    const existing = personMap.get(m.personId);
    if (existing) {
      existing.deptCodes.add(m.department.code);
    } else {
      personMap.set(m.personId, {
        person: m.person,
        deptCodes: new Set([m.department.code]),
      });
    }
  }

  // 4. Apply q filter (name or netId, case-insensitive contains).
  const qLower = q?.trim().toLowerCase();

  const scope = Array.from(personMap.values()).filter(({ person }) => {
    if (!qLower) return true;
    const nameMatch = person.name?.toLowerCase().includes(qLower) ?? false;
    const netIdMatch = person.netId?.toLowerCase().includes(qLower) ?? false;
    return nameMatch || netIdMatch;
  });

  // 5. Resolve verifier names for all newest certs in scope in one query.
  const verifierIds = Array.from(
    new Set(
      scope
        .map(({ person }) =>
          person.hipaaCertificates.length > 0
            ? person.hipaaCertificates[0].verifiedById
            : null
        )
        .filter((id): id is string => id !== null)
    )
  );

  const verifierNameMap = new Map<string, string>();
  if (verifierIds.length > 0) {
    const verifiers = await prisma.person.findMany({
      where: { id: { in: verifierIds } },
      select: { id: true, name: true },
    });
    for (const v of verifiers) {
      if (v.name) verifierNameMap.set(v.id, v.name);
    }
  }

  // 6. Compute status for each person and build the full scope rows.
  const scopeRows: MasterComplianceRow[] = scope.map(({ person, deptCodes }) => {
    const newestCert: HipaaCertificate | null =
      person.hipaaCertificates.length > 0 ? person.hipaaCertificates[0] : null;

    const computedStatus = complianceStatus(
      newestCert ? { completionDate: newestCert.completionDate } : null,
      activeTerm.endDate
    );

    const verifiedByName = newestCert?.verifiedById
      ? (verifierNameMap.get(newestCert.verifiedById) ?? null)
      : null;

    const trainingState: TrainingState = completedTraining.has(person.id) ? "COMPLETE" : "PENDING";
    return {
      // One row per person (not per membership): kind is intentionally omitted.
      person,
      cert: newestCert,
      status: computedStatus,
      verifiedByName,
      departments: Array.from(deptCodes).sort(),
      trainingState,
      overallClearance: overallClearance(computedStatus, trainingState),
    };
  });

  // 7. Compute summary over the FULL scope (before status filter).
  const summary: Record<ComplianceStatus, number> = { ...EMPTY_SUMMARY };
  for (const row of scopeRows) {
    summary[row.status]++;
  }

  // 8. Apply status filter to narrow rows.
  const filteredRows = status
    ? scopeRows.filter((row) => row.status === status)
    : scopeRows;

  // 9. Sort: non-compliant first then name alphabetically.
  filteredRows.sort((a, b) => {
    const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDiff !== 0) return statusDiff;
    return a.person.name.localeCompare(b.person.name);
  });

  // 10. Paginate.
  const total = filteredRows.length;
  const pageCount = Math.ceil(total / pageSize);
  const offset = (page - 1) * pageSize;
  const rows = filteredRows.slice(offset, offset + pageSize);

  return { rows, total, page, pageCount, summary };
}

// ---------------------------------------------------------------------------
// verifyCertificate
// ---------------------------------------------------------------------------

/**
 * Stamp a HIPAA certificate as verified.
 *
 * Re-verify is allowed and updates the stamp. Audits with action
 * "compliance.verify" and payload { certId, ownerPersonId }.
 *
 * Throws CertificateNotFoundError when the cert does not exist.
 */
export async function verifyCertificate(
  actorPersonId: string,
  certId: string
): Promise<void> {
  const cert = await prisma.hipaaCertificate.findUnique({ where: { id: certId } });
  if (!cert) throw new CertificateNotFoundError(certId);

  // The mutation scope must match the read scope: actors may only verify
  // certificates they are also permitted to view (self, manage_compliance, or
  // director of a department the certificate owner belongs to in the active term).
  const allowed = await canViewCertificate(actorPersonId, cert.personId);
  if (!allowed) {
    throw new ComplianceForbiddenError(
      "You can only verify certificates for members of your departments."
    );
  }

  const now = new Date();

  await prisma.hipaaCertificate.update({
    where: { id: certId },
    data: { verifiedById: actorPersonId, verifiedAt: now },
  });

  await recordAudit({
    actorPersonId,
    action: "compliance.verify",
    entityType: "HipaaCertificate",
    entityId: certId,
    after: { certId, ownerPersonId: cert.personId },
  });
}

// ---------------------------------------------------------------------------
// setCompletionDateAsManager
// ---------------------------------------------------------------------------

/**
 * Set a HIPAA certificate's completion date as a compliance manager.
 *
 * Only holders of `volunteers.manage_compliance` may call this (a master-key
 * check, NOT canViewCertificate: department directors do not get date entry).
 * Entry is set-once: a cert that already has a completionDate is rejected.
 *
 * Setting the date also verifies the cert (the manager read the PDF to get the
 * date), so completionDate, extraction=MANUAL, and the verified stamp are
 * written in one transaction alongside the Person mirror enqueue. Audits
 * "compliance.set_date" with before/after.
 *
 * Throws ComplianceForbiddenError (not a manager), CertificateNotFoundError
 * (no such cert), or CompletionDateError (already set, or invalid date).
 */
export async function setCompletionDateAsManager(
  actorPersonId: string,
  certId: string,
  dateIso: string
): Promise<void> {
  if (!(await can(actorPersonId, "volunteers.manage_compliance"))) {
    throw new ComplianceForbiddenError(
      "Only compliance managers can set certificate completion dates."
    );
  }

  const cert = await prisma.hipaaCertificate.findUnique({ where: { id: certId } });
  if (!cert) throw new CertificateNotFoundError(certId);

  // Set-once. This guard runs before the transaction, so two managers racing on
  // the same dateless cert could both pass it; the second write simply overwrites
  // the first and both writes are visible in the audit log. Compliance-manager
  // concurrency on one cert is vanishingly rare, so we accept that over taking a
  // row lock here. Do not "fix" this by moving it into the transaction without
  // considering the audit/UX implications.
  if (cert.completionDate !== null) {
    throw new CompletionDateError("completion date is already set");
  }

  // Validates format/future/5-year and normalizes to noon UTC. Throws CompletionDateError.
  const completionDate = parseCompletionDate(dateIso);
  const now = new Date();

  const before = {
    completionDate: null,
    extraction: cert.extraction,
    verifiedById: cert.verifiedById ?? null,
    verifiedAt: cert.verifiedAt ?? null,
  };

  await prisma.$transaction(async (tx) => {
    await tx.hipaaCertificate.update({
      where: { id: cert.id },
      data: {
        completionDate,
        extraction: "MANUAL",
        verifiedById: actorPersonId,
        verifiedAt: now,
      },
    });

    await enqueueMirror(tx, {
      entityType: "Person",
      entityId: cert.personId,
      changedFields: ["hipaaStatus"],
    });
  });

  await recordAudit({
    actorPersonId,
    action: "compliance.set_date",
    entityType: "HipaaCertificate",
    entityId: cert.id,
    before,
    after: { completionDate, extraction: "MANUAL", verifiedById: actorPersonId, verifiedAt: now },
  });
}

export { CompletionDateError };
