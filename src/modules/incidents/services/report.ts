/**
 * Incident Reports service: intake (submitReport) plus the reviewer and strike
 * flows (see report-review.ts additions in later tasks). A report is filed by
 * any signed-in person about anyone. A director filing about a volunteer they
 * manage may request a strike (strikeDecision = PENDING), which a reviewer later
 * approves or declines.
 */

import type {
  IncidentReport,
  IncidentReportAttachment,
  IncidentReportStatus,
  PatientImpact,
  IssueNature,
  PriorOccurrence,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { manageableDepartmentIds } from "@/platform/departments";
import { getActiveTerm } from "@/platform/terms/active-term";
import { can } from "@/platform/rbac/engine";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONCERN_TYPES = [
  { value: "PATIENT_SAFETY", label: "Patient Safety", help: "failure to escalate, scope violations, medication errors, unsafe handoffs" },
  { value: "PRIVACY_HIPAA", label: "Privacy / HIPAA", help: "unauthorized chart access, unsecured sharing, unlocked screens" },
  { value: "PROFESSIONAL_CONDUCT", label: "Professional Conduct", help: "disrespect, intimidation, discriminatory behavior, bullying" },
  { value: "ROLE_SCOPE", label: "Role Scope Violation", help: "bypassing chain of command, unauthorized patient contact or referrals" },
  { value: "DOCUMENTATION_WORKFLOW", label: "Documentation / Workflow", help: "incomplete notes, unsigned tasks, referral mishandling" },
  { value: "ATTENDANCE_RELIABILITY", label: "Attendance / Reliability", help: "no-call/no-show, chronic late arrival, uncovered departures" },
  { value: "SYSTEM_ADVERSE_EVENT", label: "System / Adverse Event", help: "workflow gap, near miss, delayed referral" },
  { value: "OTHER", label: "Other / Unsure", help: "describe in the narrative" },
] as const;

export const CONCERN_TYPE_VALUES: string[] = CONCERN_TYPES.map((t) => t.value);

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class IncidentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncidentValidationError";
  }
}

export class IncidentForbiddenError extends Error {
  constructor(message = "You do not have permission for that action.") {
    super(message);
    this.name = "IncidentForbiddenError";
  }
}

export class IncidentNotFoundError extends Error {
  constructor(message = "Incident report not found.") {
    super(message);
    this.name = "IncidentNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubmitReportInput = {
  concernTypes: string[];
  description: string;
  occurredAt?: Date | null;
  setting?: string | null;
  subjectPersonId?: string | null;
  subjectDescription?: string | null;
  patientImpact?: PatientImpact | null;
  patientImpactDetail?: string | null;
  immediateRisk?: boolean;
  issueNature?: IssueNature | null;
  priorOccurrence?: PriorOccurrence | null;
  priorOccurrenceDetail?: string | null;
  anonymous?: boolean;
  requestStrike?: boolean;
};

// ---------------------------------------------------------------------------
// Strike-request guard
// ---------------------------------------------------------------------------

/**
 * True if the actor may request a strike against the subject: the subject has an
 * ACTIVE VOLUNTEER-kind membership in one of the actor's manageable departments
 * in the active term. Reviewers are not special-cased here; they issue strikes
 * directly on the ledger.
 */
export async function canRequestStrikeAgainst(actorPersonId: string, subjectPersonId: string): Promise<boolean> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return false;
  const deptIds = await manageableDepartmentIds(actorPersonId);
  if (deptIds.length === 0) return false;
  const membership = await prisma.termMembership.findFirst({
    where: {
      personId: subjectPersonId,
      termId: activeTerm.id,
      departmentId: { in: deptIds },
      status: "ACTIVE",
      kind: "VOLUNTEER",
    },
  });
  return membership !== null;
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

/**
 * Files a new incident report as SUBMITTED.
 *
 * Validation (IncidentValidationError):
 *   - concernTypes must be non-empty and each value must be a known CONCERN_TYPE_VALUES entry.
 *   - description must be non-blank.
 *   - occurredAt must not be in the future.
 *   - requestStrike requires subjectPersonId AND canRequestStrikeAgainst(actor, subject).
 *
 * subjectPersonId, when provided, must reference an existing Person
 * (IncidentNotFoundError otherwise).
 *
 * Audits incident.submit (entityType "IncidentReport", after:
 * { number, concernTypes, immediateRisk, strikeRequested }).
 */
export async function submitReport(actorPersonId: string, input: SubmitReportInput): Promise<IncidentReport> {
  const concernTypes = input.concernTypes ?? [];
  if (concernTypes.length === 0) {
    throw new IncidentValidationError("Select at least one type of concern.");
  }
  const invalid = concernTypes.filter((c) => !CONCERN_TYPE_VALUES.includes(c));
  if (invalid.length > 0) {
    throw new IncidentValidationError(`Unknown concern type(s): ${invalid.join(", ")}.`);
  }
  if (!input.description.trim()) {
    throw new IncidentValidationError("Describe what happened.");
  }
  if (input.occurredAt && input.occurredAt > new Date()) {
    throw new IncidentValidationError("The date of the incident must not be in the future.");
  }
  if (input.subjectPersonId) {
    const subject = await prisma.person.findUnique({ where: { id: input.subjectPersonId } });
    if (!subject) throw new IncidentNotFoundError(`Subject ${input.subjectPersonId} not found.`);
  }

  let strikeDecision: "PENDING" | null = null;
  if (input.requestStrike) {
    if (!input.subjectPersonId) {
      throw new IncidentValidationError("A strike can only be requested against a specific person.");
    }
    const allowed = await canRequestStrikeAgainst(actorPersonId, input.subjectPersonId);
    if (!allowed) {
      throw new IncidentValidationError("You can only request a strike for a volunteer in a department you manage.");
    }
    strikeDecision = "PENDING";
  }

  const report = await prisma.incidentReport.create({
    data: {
      reporterId: actorPersonId,
      anonymous: input.anonymous ?? false,
      concernTypes,
      description: input.description,
      occurredAt: input.occurredAt ?? null,
      setting: input.setting ?? null,
      subjectPersonId: input.subjectPersonId ?? null,
      subjectDescription: input.subjectDescription ?? null,
      patientImpact: input.patientImpact ?? null,
      patientImpactDetail: input.patientImpactDetail ?? null,
      immediateRisk: input.immediateRisk ?? false,
      issueNature: input.issueNature ?? null,
      priorOccurrence: input.priorOccurrence ?? null,
      priorOccurrenceDetail: input.priorOccurrenceDetail ?? null,
      strikeDecision,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "incident.submit",
    entityType: "IncidentReport",
    entityId: report.id,
    after: { number: report.number, concernTypes, immediateRisk: report.immediateRisk, strikeRequested: strikeDecision !== null },
  });

  return report;
}

// ---------------------------------------------------------------------------
// Read: my reports and per-report visibility
// ---------------------------------------------------------------------------

export type ReportListRow = { report: IncidentReport; subjectName: string | null };

/**
 * A reporter's own reports, newest first.
 */
export async function listMyReports(actorPersonId: string): Promise<ReportListRow[]> {
  const reports = await prisma.incidentReport.findMany({
    where: { reporterId: actorPersonId },
    include: { subject: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return reports.map((r) => ({ report: r, subjectName: r.subject?.name ?? null }));
}

/**
 * A single report with its subject, reporter, and attachments.
 *
 * Visibility: the reporter (owner) or a holder of incidents.manage; anyone
 * else throws IncidentForbiddenError. Missing report throws IncidentNotFoundError.
 * reviewNotes (reviewer-internal) is stripped to null for non-managers, even
 * when they are the owner.
 */
export async function getReport(
  actorPersonId: string,
  id: string
): Promise<{
  report: IncidentReport & {
    subject: { name: string } | null;
    reporter: { name: string };
    attachments: IncidentReportAttachment[];
  };
  canManage: boolean;
}> {
  const report = await prisma.incidentReport.findUnique({
    where: { id },
    include: {
      subject: { select: { name: true } },
      reporter: { select: { name: true } },
      attachments: true,
    },
  });
  if (!report) throw new IncidentNotFoundError();

  const canManage = await can(actorPersonId, "incidents.manage");
  const isOwner = report.reporterId === actorPersonId;
  if (!canManage && !isOwner) throw new IncidentForbiddenError();

  // Reviewer-internal notes are never returned to a non-manager, even the owner.
  const safe = canManage ? report : { ...report, reviewNotes: null };
  return { report: safe, canManage };
}

// ---------------------------------------------------------------------------
// Reviewer queue and disposition
// ---------------------------------------------------------------------------

export type ReviewFilters = {
  status?: string;
  concernType?: string;
  immediateRisk?: boolean;
  strikePending?: boolean;
  q?: string;
  page?: number;
};

const REVIEW_PAGE_SIZE = 25;

export type ReviewQueueRow = { report: IncidentReport; reporterName: string; subjectName: string | null };

/**
 * All incident reports, filtered and paginated for a reviewer. Requires
 * incidents.manage (else IncidentForbiddenError).
 *
 * Filters: status (exact), concernType (array contains), immediateRisk (true
 * only), strikePending (strikeDecision === PENDING), q (case-insensitive
 * match against subject name, reporter name, or report number).
 *
 * Ordered with immediateRisk reports first, then newest first. Paginated at
 * REVIEW_PAGE_SIZE (25) rows per page.
 */
export async function listReviewQueue(
  actorPersonId: string,
  filters: ReviewFilters
): Promise<{ rows: ReviewQueueRow[]; total: number }> {
  if (!(await can(actorPersonId, "incidents.manage"))) throw new IncidentForbiddenError();

  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.IncidentReportWhereInput = {};
  if (filters.status) where.status = filters.status as IncidentReportStatus;
  if (filters.concernType) where.concernTypes = { has: filters.concernType };
  if (filters.immediateRisk) where.immediateRisk = true;
  if (filters.strikePending) where.strikeDecision = "PENDING";
  if (filters.q) {
    const q = filters.q.trim();
    const asNumber = Number.parseInt(q, 10);
    where.OR = [
      { subject: { name: { contains: q, mode: "insensitive" } } },
      { reporter: { name: { contains: q, mode: "insensitive" } } },
      ...(Number.isNaN(asNumber) ? [] : [{ number: asNumber }]),
    ];
  }

  const [reports, total] = await Promise.all([
    prisma.incidentReport.findMany({
      where,
      include: { subject: { select: { name: true } }, reporter: { select: { name: true } } },
      orderBy: [{ immediateRisk: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * REVIEW_PAGE_SIZE,
      take: REVIEW_PAGE_SIZE,
    }),
    prisma.incidentReport.count({ where }),
  ]);

  return {
    rows: reports.map((r) => ({ report: r, reporterName: r.reporter.name, subjectName: r.subject?.name ?? null })),
    total,
  };
}

/**
 * Sets a report's status and reviewer notes. Requires incidents.manage
 * (else IncidentForbiddenError). Missing report throws IncidentNotFoundError.
 *
 * reviewNotes: when omitted (undefined), the existing notes are kept; pass
 * null explicitly to clear them.
 *
 * resolvedById/resolvedAt are stamped with the actor and now() when status is
 * RESOLVED or DISMISSED, and cleared to null for any other status (e.g. a
 * report moved back to UNDER_REVIEW).
 *
 * Audits incident.review (entityType "IncidentReport", after: { status }).
 */
export async function reviewReport(
  actorPersonId: string,
  id: string,
  input: { status: IncidentReportStatus; reviewNotes?: string | null }
): Promise<IncidentReport> {
  if (!(await can(actorPersonId, "incidents.manage"))) throw new IncidentForbiddenError();
  const existing = await prisma.incidentReport.findUnique({ where: { id } });
  if (!existing) throw new IncidentNotFoundError();

  const terminal = input.status === "RESOLVED" || input.status === "DISMISSED";
  const updated = await prisma.incidentReport.update({
    where: { id },
    data: {
      status: input.status,
      reviewNotes: input.reviewNotes === undefined ? existing.reviewNotes : input.reviewNotes,
      resolvedById: terminal ? actorPersonId : null,
      resolvedAt: terminal ? new Date() : null,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "incident.review",
    entityType: "IncidentReport",
    entityId: id,
    after: { status: updated.status },
  });

  return updated;
}
