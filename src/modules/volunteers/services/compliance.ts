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
import { complianceStatus } from "@/platform/compliance/rules";
import type { ComplianceStatus } from "@/platform/compliance/rules";

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

export class CertificateNotFoundError extends Error {
  constructor(certId: string) {
    super(`Certificate not found: ${certId}`);
    this.name = "CertificateNotFoundError";
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
 * Returns compliance data for all departments where the viewer holds an
 * ACTIVE DIRECTOR membership in the active term.
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

  // 2. Get departments where the viewer is an ACTIVE DIRECTOR in the active term.
  const directorships = await prisma.termMembership.findMany({
    where: {
      personId: viewerPersonId,
      termId: activeTerm.id,
      kind: "DIRECTOR",
      status: "ACTIVE",
    },
    include: { department: true },
  });
  if (directorships.length === 0) return [];

  const deptIds = directorships.map((d) => d.departmentId);

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

  // 5. Group by department and compute per-member compliance.
  const deptMap = new Map<string, { department: Department; members: MemberCompliance[] }>();

  // Ensure we have an entry for every director department, in the same order.
  for (const d of directorships) {
    if (!deptMap.has(d.departmentId)) {
      deptMap.set(d.departmentId, { department: d.department, members: [] });
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

    entry.members.push({
      person: m.person,
      kind: m.kind,
      cert: newestCert,
      status,
      verifiedByName,
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
