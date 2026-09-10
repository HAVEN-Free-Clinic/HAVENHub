/**
 * Volunteers module compliance service.
 *
 * Services trust callers for authentication; permission checks live at the
 * page/action layer. No N+1 queries: memberships are fetched with person + their
 * certs via include, then cert selection is done in JS.
 */

import type { HipaaCertificate, Person } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { captureEvent } from "@/platform/posthog/capture";
import { activeTermGroup } from "@/platform/posthog/groups";
import { complianceStatus } from "@/platform/compliance/rules";
import type { ComplianceStatus, TrainingState } from "@/platform/compliance/rules";
import { can } from "@/platform/rbac/engine";
import { parseCompletionDate, CompletionDateError } from "@/platform/compliance/completion-date";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getNextTerm } from "@/platform/terms/next-term";
import { loadClearanceMap, type ClearanceSummary } from "@/platform/clearance";
import { notifyCertVerified } from "@/platform/compliance/review-notifications";
import type { Sort } from "@/platform/lists/sort";
import { log, errorAttrs } from "@/platform/logging";
import { comparePersonName } from "@/platform/person-name";

export type { ComplianceStatus };
export type { ClearanceSummary };

/** Placeholder used before loadClearanceMap fills the real value; also the value
 *  for a person the map has no entry for (should not happen for active members). */
const EMPTY_CLEARANCE: ClearanceSummary = { onboarded: true, cleared: true, tasks: [], missing: [] };

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
  /** Full clearance: profile + HIPAA + training + learning + EHS (the real gate). */
  clearance: ClearanceSummary;
};

// ---------------------------------------------------------------------------
// Status sort order: non-compliant first
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<ComplianceStatus, number> = {
  NO_CERTIFICATE: 0,
  EXPIRED: 1,
  PENDING_VERIFICATION: 2,
  UNKNOWN_DATE: 3,
  EXPIRING_SOON: 4,
  COMPLIANT: 5,
};

/**
 * Columns the master roster can be ordered by.
 *
 * Only the two high-cardinality columns. The compliance columns beside them
 * render two- and three-valued badges, and the page already carries a Status
 * select directly above the table, so sorting them would produce blocks rather
 * than an order and duplicate a filter that is right there.
 */
export const MASTER_SORT_KEYS = ["name", "departments"] as const;

export type MasterSortKey = (typeof MASTER_SORT_KEYS)[number];

export type MasterQuery = {
  status?: ComplianceStatus;
  departmentId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  /** Overrides the default non-compliant-first order. Applied before paging, so
   *  page boundaries follow the requested order. */
  sort?: Sort<MasterSortKey>;
  /**
   * Whose roster: the live term (the default) or the next one. Anything else
   * reads as live. The next term is what lets a compliance manager verify the
   * certificates promotion collected BEFORE the flip. The roster used to read
   * the live term only, so people promoted onto next term alone could not be
   * found to verify until the onboarding gate was already holding them.
   */
  termId?: string;
  /**
   * The departments the viewer may see, or undefined for the whole clinic. A
   * department director's roster is this one restricted to the departments
   * they direct (manageableDepartmentIds), which is what lets /volunteers be one
   * table for both audiences. A `departmentId` filter outside the scope matches
   * nothing: a filter narrows, it can never widen what the viewer may see.
   */
  scopeDepartmentIds?: string[];
};

/** The membership department clause: the filter, held inside the scope. */
function rosterDepartmentWhere(
  departmentId: string | undefined,
  scope: string[] | undefined,
): { departmentId?: string | { in: string[] } } {
  if (!scope) return departmentId ? { departmentId } : {};
  return { departmentId: { in: departmentId ? scope.filter((id) => id === departmentId) : scope } };
}

/**
 * The master view is one row per PERSON, not per membership, so it does not
 * carry a membership `kind`. Omitting it (rather than using a placeholder) keeps
 * the type honest -- the master table never displays a director/volunteer badge.
 *
 * `isVolunteer` is true when the person holds at least one ACTIVE VOLUNTEER
 * membership in the active term. Director-only members train on the DIRECTOR
 * track, so volunteer-track training does not apply to them; the master view
 * uses this flag to render "-" for Training/Overall instead of flagging them
 * as Pending/Not Cleared.
 */
export type MasterComplianceRow = Omit<MemberCompliance, "kind"> & {
  departments: string[];
  isVolunteer: boolean;
};

export type MasterComplianceResult = {
  rows: MasterComplianceRow[];
  total: number;
  page: number;
  pageCount: number;
  summary: Record<ComplianceStatus, number>;
  /** People fully cleared (all six requirements) across the pre-status scope. */
  clearedCount: number;
  /** People with at least one outstanding required EHS training across the scope. */
  ehsMissingCount: number;
};

const EMPTY_SUMMARY: Record<ComplianceStatus, number> = {
  COMPLIANT: 0,
  EXPIRING_SOON: 0,
  EXPIRED: 0,
  PENDING_VERIFICATION: 0,
  UNKNOWN_DATE: 0,
  NO_CERTIFICATE: 0,
};

/** The live term, or the next one when that is what `termId` names. */
async function masterTerm(termId: string | undefined) {
  const live = await getActiveTerm();
  if (!termId || termId === live?.id) return live;
  const next = await getNextTerm();
  return next && next.id === termId ? next : live;
}

/**
 * Returns compliance data for ALL active people with at least one ACTIVE
 * membership in the shown term: the live one, or the next one when
 * `query.termId` asks for it. One row per PERSON (not per membership).
 *
 * The summary counts are computed over the FULL filtered-by-q/departmentId
 * scope BEFORE the status filter, so the count chips always show the whole
 * picture for the current search/department scope. The status filter then
 * narrows which rows are returned and what total/pageCount reflect.
 *
 * Pagination uses pageSize 25 by default. Page is 1-based.
 *
 * `sort` overrides the row order and nothing else. The default order is
 * load-bearing -- it is what puts the people needing action on page 1 -- so it
 * stays exactly as it was whenever no sort is asked for.
 */
export async function masterCompliance(
  query: MasterQuery
): Promise<MasterComplianceResult> {
  const { status, departmentId, q, page = 1, pageSize = 25, sort, scopeDepartmentIds } = query;

  // 1. Find the term being shown: live by default, next when asked for.
  const shownTerm = await masterTerm(query.termId);

  if (!shownTerm) {
    return {
      rows: [],
      total: 0,
      page: 1,
      pageCount: 0,
      summary: { ...EMPTY_SUMMARY },
      clearedCount: 0,
      ehsMissingCount: 0,
    };
  }

  // 2. Fetch ALL ACTIVE memberships in the active term (optionally narrowed by
  //    departmentId, and held to the viewer's scope), with person + their certs,
  //    in one query.
  const memberships = await prisma.termMembership.findMany({
    where: {
      termId: shownTerm.id,
      status: "ACTIVE",
      ...rosterDepartmentWhere(departmentId, scopeDepartmentIds),
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

  // 2b. Fetch the set of people with COMPLETE training for the shown term once.
  const completedTraining = new Set(
    (await prisma.training.findMany({
      where: { termId: shownTerm.id, track: "VOLUNTEER", status: "COMPLETE" },
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
      isVolunteer: boolean;
    }
  >();

  for (const m of memberships) {
    const existing = personMap.get(m.personId);
    if (existing) {
      existing.deptCodes.add(m.department.code);
      // A person volunteering in any department trains on the VOLUNTEER track.
      if (m.kind === "VOLUNTEER") existing.isVolunteer = true;
    } else {
      personMap.set(m.personId, {
        person: m.person,
        deptCodes: new Set([m.department.code]),
        isVolunteer: m.kind === "VOLUNTEER",
      });
    }
  }

  // 4. Apply q filter (name, netId or email, case-insensitive contains).
  //    Email is searchable because the roster now shows it, and because it
  //    matches what /admin/people has always accepted -- someone pasting the
  //    address off an email to look a member up should land on them.
  const qLower = q?.trim().toLowerCase();

  const scope = Array.from(personMap.values()).filter(({ person }) => {
    if (!qLower) return true;
    const nameMatch = person.name?.toLowerCase().includes(qLower) ?? false;
    const netIdMatch = person.netId?.toLowerCase().includes(qLower) ?? false;
    const emailMatch = person.contactEmail?.toLowerCase().includes(qLower) ?? false;
    return nameMatch || netIdMatch || emailMatch;
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
  const scopeRows: MasterComplianceRow[] = scope.map(({ person, deptCodes, isVolunteer }) => {
    const newestCert: HipaaCertificate | null =
      person.hipaaCertificates.length > 0 ? person.hipaaCertificates[0] : null;

    const computedStatus = complianceStatus(
      newestCert ? { completionDate: newestCert.completionDate, verifiedAt: newestCert.verifiedAt } : null,
      shownTerm.endDate
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
      isVolunteer,
      trainingState,
      clearance: EMPTY_CLEARANCE,
    };
  });

  // Full clearance for the whole scope (matches how summary is computed pre-pagination).
  const scopeIds = scopeRows.map((r) => r.person.id);
  const clearanceMap = await loadClearanceMap(scopeIds, shownTerm.id);
  for (const row of scopeRows) {
    row.clearance = clearanceMap.get(row.person.id) ?? EMPTY_CLEARANCE;
  }
  const clearedCount = scopeRows.filter((r) => r.clearance.cleared).length;
  const ehsMissingCount = scopeRows.filter((r) => r.clearance.missing.includes("ehs")).length;

  // 7. Compute summary over the FULL scope (before status filter).
  const summary: Record<ComplianceStatus, number> = { ...EMPTY_SUMMARY };
  for (const row of scopeRows) {
    summary[row.status]++;
  }

  // 8. Apply status filter to narrow rows.
  const filteredRows = status
    ? scopeRows.filter((row) => row.status === status)
    : scopeRows;

  // 9. Sort. Default: non-compliant first then name alphabetically. A requested
  //    sort replaces the leading term only -- name stays the tiebreaker either
  //    way, so rows never swap places between two renders of the same page and
  //    paging cannot repeat or drop somebody.
  filteredRows.sort((a, b) => {
    if (sort) {
      const sign = sort.dir === "asc" ? 1 : -1;
      const primary =
        sort.key === "departments"
          ? a.departments.join(", ").localeCompare(b.departments.join(", "))
          : comparePersonName(a.person, b.person);
      if (primary !== 0) return primary * sign;
      return comparePersonName(a.person, b.person);
    }
    const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDiff !== 0) return statusDiff;
    return comparePersonName(a.person, b.person);
  });

  // 10. Paginate.
  const total = filteredRows.length;
  const pageCount = Math.ceil(total / pageSize);
  const offset = (page - 1) * pageSize;
  const rows = filteredRows.slice(offset, offset + pageSize);

  return { rows, total, page, pageCount, summary, clearedCount, ehsMissingCount };
}

/**
 * Notify a certificate owner that their certificate is now verified. Shared by
 * both paths that can flip a cert from unverified to verified: verifyCertificate
 * (parsed date, manager confirms it) and setCompletionDateAsManager (parser
 * could not read a date, manager enters it and verifies in the same action).
 * Both populations must hear the same thing.
 *
 * The certificate is already durably updated and audited by the time this
 * runs, so a notification failure must not surface to the manager as a failed
 * verification. Same isolation as saveCertificate's manager alerts: catch,
 * log, continue.
 */
async function notifyCertOwnerOfVerification(personId: string, certId: string): Promise<void> {
  try {
    const owner = await prisma.person.findUnique({
      where: { id: personId },
      select: { name: true, entraObjectId: true, contactEmail: true },
    });
    if (owner) {
      await notifyCertVerified(prisma, {
        id: personId,
        name: owner.name,
        entraObjectId: owner.entraObjectId,
        contactEmail: owner.contactEmail,
      });
    }
  } catch (err) {
    log.error("[compliance] failed to notify member of certificate verification", errorAttrs(err, { certId }));
  }
}

/**
 * Stamp a HIPAA certificate as verified.
 *
 * Re-verify is allowed and updates the stamp. Audits with action
 * "compliance.verify" and payload { certId, ownerPersonId }.
 *
 * Authorization mirrors setCompletionDateAsManager: only holders of
 * `volunteers.manage_compliance` or `admin.access` may verify. Department
 * directors keep read access to their members' certificates (canViewCertificate)
 * but attesting a certificate is a compliance-manager/admin action, not a
 * director one. The existence check fires first, so an unauthorized actor
 * probing a nonexistent certId still gets CertificateNotFoundError.
 *
 * Throws CertificateNotFoundError when the cert does not exist, or
 * ComplianceForbiddenError when the actor is neither manager nor admin, or when
 * the actor owns the certificate (self-verification is disallowed).
 */
export async function verifyCertificate(
  actorPersonId: string,
  certId: string
): Promise<void> {
  const cert = await prisma.hipaaCertificate.findUnique({ where: { id: certId } });
  if (!cert) throw new CertificateNotFoundError(certId);

  const isManager = await can(actorPersonId, "volunteers.manage_compliance");
  const isAdmin = await can(actorPersonId, "admin.access");
  if (!isManager && !isAdmin) {
    throw new ComplianceForbiddenError(
      "Only compliance managers or admins can verify certificates."
    );
  }

  // Separation of duties: verification must be independent. A compliance
  // manager/admin who is also a clinical volunteer cannot attest their own
  // certificate; another manager or admin must verify it.
  if (cert.personId === actorPersonId) {
    throw new ComplianceForbiddenError(
      "You cannot verify your own certificate; another compliance manager or admin must verify it."
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

  // Fire once, on the not-verified -> verified transition, attributed to the
  // certificate owner (the person being cleared) for the clearance funnel.
  if (!cert.verifiedAt) {
    await captureEvent({
      event: "hipaa_certificate_verified",
      distinctId: cert.personId,
      properties: { verified_by: actorPersonId, via: "verify" },
      groups: await activeTermGroup(),
    });

    // Close the loop back to the member.
    await notifyCertOwnerOfVerification(cert.personId, certId);
  }
}

/**
 * Set a HIPAA certificate's completion date as a compliance manager or admin.
 *
 * Holders of `volunteers.manage_compliance` may call this for dateless certs
 * only (a master-key check, NOT canViewCertificate: department directors do not
 * get date entry). Entry is set-once for compliance managers: a cert that
 * already has a completionDate is rejected. Holders of `admin.access` may also
 * call this, and may overwrite an existing date to correct a wrong entry.
 *
 * Setting the date also verifies the cert (the actor read the PDF to get the
 * date), so completionDate, extraction=MANUAL, and the verified stamp are
 * written together. Audits "compliance.set_date" with before/after. The before
 * snapshot captures the
 * real prior state (including any existing completionDate) so overwrites are
 * fully traceable.
 *
 * Throws ComplianceForbiddenError (neither manager nor admin, or the actor owns
 * the cert, since self-dating is disallowed), CertificateNotFoundError (no such
 * cert), or CompletionDateError (already set for non-admin, or invalid date).
 */
export async function setCompletionDateAsManager(
  actorPersonId: string,
  certId: string,
  dateIso: string
): Promise<void> {
  const isAdmin = await can(actorPersonId, "admin.access");
  const isManager = await can(actorPersonId, "volunteers.manage_compliance");
  if (!isManager && !isAdmin) {
    throw new ComplianceForbiddenError(
      "Only compliance managers or admins can set certificate completion dates."
    );
  }

  const cert = await prisma.hipaaCertificate.findUnique({ where: { id: certId } });
  if (!cert) throw new CertificateNotFoundError(certId);

  // Separation of duties: setting a completion date also verifies the cert, so
  // the actor cannot do it for their own certificate; another manager or admin must.
  if (cert.personId === actorPersonId) {
    throw new ComplianceForbiddenError(
      "You cannot set the completion date on your own certificate; another compliance manager or admin must."
    );
  }

  // Set-once for compliance managers: a cert that already has a date is rejected.
  // Superadmins (admin.access) may overwrite to correct a wrong date. As before,
  // this guard runs before the transaction, so two concurrent writers could race;
  // the later write wins and both are visible in the audit log. That is acceptable
  // given how rare concurrent edits on one cert are. Do not move this into the
  // transaction without weighing the audit/UX implications.
  if (cert.completionDate !== null && !isAdmin) {
    throw new CompletionDateError("completion date is already set");
  }

  // Validates format/future/5-year and normalizes to noon UTC. Throws CompletionDateError.
  const completionDate = parseCompletionDate(dateIso);
  const now = new Date();

  const before = {
    completionDate: cert.completionDate ?? null,
    extraction: cert.extraction,
    verifiedById: cert.verifiedById ?? null,
    verifiedAt: cert.verifiedAt ?? null,
  };

  await prisma.hipaaCertificate.update({
    where: { id: cert.id },
    data: {
      completionDate,
      extraction: "MANUAL",
      verifiedById: actorPersonId,
      verifiedAt: now,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "compliance.set_date",
    entityType: "HipaaCertificate",
    entityId: cert.id,
    before,
    after: { completionDate, extraction: "MANUAL", verifiedById: actorPersonId, verifiedAt: now },
  });

  // Setting the date also verifies the cert; fire the same milestone once, on
  // the not-verified -> verified transition, and close the loop back to the
  // member the same way verifyCertificate does. This is the dateless-cert
  // population (UNKNOWN_DATE): the PDF parser could not read a date, so this
  // is their only path to clearance and they must hear about it too.
  if (!cert.verifiedAt) {
    await captureEvent({
      event: "hipaa_certificate_verified",
      distinctId: cert.personId,
      properties: { verified_by: actorPersonId, via: "set_date" },
      groups: await activeTermGroup(),
    });

    await notifyCertOwnerOfVerification(cert.personId, cert.id);
  }
}

export { CompletionDateError };
