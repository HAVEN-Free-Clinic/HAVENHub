/**
 * Incident Reports service: intake (submitReport) plus the reviewer and strike
 * flows (see report-review.ts additions in later tasks). A report is filed by
 * any signed-in person about anyone. A director filing about a volunteer they
 * manage may request a strike (strikeDecision = PENDING), which a reviewer later
 * approves or declines.
 */

import path from "node:path";
import type {
  IncidentReport,
  IncidentReportAttachment,
  IncidentReportStatus,
  PatientImpact,
  IssueNature,
  PriorOccurrence,
  Prisma,
  DisciplinaryAction,
} from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { manageableDepartmentIds } from "@/platform/departments";
import { getActiveTerm } from "@/platform/terms/active-term";
import { can } from "@/platform/rbac/engine";
import { getSetting } from "@/platform/settings/service";
import { putObject, deleteObject } from "@/platform/storage";
import { validateUploadedFile } from "@/modules/recruitment/services/upload";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import {
  reportSubmittedContext,
  strikeRequestedContext,
  strikeDecidedContext,
  reportResolvedContext,
} from "@/platform/email/templates/incidents";
import { issueAction, DISCIPLINARY_CATEGORIES } from "./disciplinary";

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

/** value -> human label, for building the comma-separated concernSummary in notification emails. */
const CONCERN_LABELS: Record<string, string> = Object.fromEntries(CONCERN_TYPES.map((t) => [t.value, t.label]));

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
  files?: Array<{ fileName: string; mimeType: string; bytes: Buffer }>;
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

export type SubjectOption = { id: string; name: string; hint: string | null };

/**
 * People the reporter can link as the subject of a report, plus the subset the
 * reporter may request a strike against.
 *
 * `people`: every ACTIVE person (volunteer, director, or staff), each with a
 * short role/department hint derived from their active-term membership (null for
 * people with no active membership, e.g. staff). The report form filters this
 * list client-side, so linking is not limited to the reporter's own volunteers.
 *
 * `strikeEligibleIds`: the ACTIVE VOLUNTEER-kind members in the reporter's
 * manageable departments in the active term, matching canRequestStrikeAgainst
 * exactly. Directors are excluded, since that guard rejects strike requests
 * against non-volunteers. The "Request a strike" control is only offered for
 * these; submitReport re-checks eligibility server-side.
 */
export async function listSubjectOptions(actorPersonId: string): Promise<{
  people: SubjectOption[];
  strikeEligibleIds: string[];
}> {
  const activeTerm = await getActiveTerm();
  const deptIds = await manageableDepartmentIds(actorPersonId);
  const [persons, memberships, strikeEligible] = await Promise.all([
    prisma.person.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    activeTerm
      ? prisma.termMembership.findMany({
          where: { termId: activeTerm.id, status: "ACTIVE" },
          select: { personId: true, kind: true, department: { select: { code: true } } },
        })
      : [],
    // Strike eligibility mirrors canRequestStrikeAgainst exactly: ACTIVE
    // VOLUNTEER-kind members in the reporter's manageable departments in the
    // active term. Directors are deliberately excluded so the affordance is
    // never shown for subjects the guard would reject.
    activeTerm && deptIds.length > 0
      ? prisma.termMembership.findMany({
          where: {
            termId: activeTerm.id,
            departmentId: { in: deptIds },
            status: "ACTIVE",
            kind: "VOLUNTEER",
          },
          select: { personId: true },
        })
      : [],
  ]);

  // Build a "SCTM, JCTM volunteer/director" style hint per person from their
  // active memberships so same-named people are distinguishable in the picker.
  const hints = new Map<string, { depts: Set<string>; kinds: Set<string> }>();
  for (const m of memberships) {
    const entry = hints.get(m.personId) ?? { depts: new Set<string>(), kinds: new Set<string>() };
    if (m.department?.code) entry.depts.add(m.department.code);
    if (m.kind) entry.kinds.add(m.kind === "DIRECTOR" ? "director" : "volunteer");
    hints.set(m.personId, entry);
  }

  const people: SubjectOption[] = persons.map((p) => {
    const h = hints.get(p.id);
    const hint = h
      ? [[...h.depts].sort().join(", "), [...h.kinds].sort().join("/")].filter(Boolean).join(" ")
      : "";
    return { id: p.id, name: p.name, hint: hint || null };
  });

  const strikeEligibleIds = [...new Set(strikeEligible.map((m) => m.personId))];
  return { people, strikeEligibleIds };
}

// ---------------------------------------------------------------------------
// Notifications (best-effort -- never throws out of a committed mutation)
// ---------------------------------------------------------------------------

/**
 * Alerts every incidents.manage holder that a report was just submitted
 * (incidents.report_submitted), and, when the report also carries a pending
 * strike request, alerts the same reviewers a second time
 * (incidents.strike_requested). The subject is never a recipient here --
 * only reviewers. Called after the report row (and any attachments) commit;
 * a delivery failure is logged and swallowed so it can never roll back or
 * throw out of submitReport.
 */
async function notifyReviewersOfSubmission(report: IncidentReport, actorPersonId: string): Promise<void> {
  try {
    const reviewers = await peopleWithAnyPermission(["incidents.manage"]);
    if (reviewers.length === 0) return;

    const baseUrl = await getSetting<string>("app.baseUrl");
    const reviewLink = `${baseUrl}/incidents/review`;
    const concernSummary = report.concernTypes.map((c) => CONCERN_LABELS[c] ?? c).join(", ");

    let subjectName: string | null = null;
    if (report.strikeDecision === "PENDING" && report.subjectPersonId) {
      const subject = await prisma.person.findUnique({
        where: { id: report.subjectPersonId },
        select: { name: true },
      });
      subjectName = subject?.name ?? "the subject";
    }

    for (const reviewer of reviewers) {
      const submittedRendered = await renderEmail(
        "incidents.report_submitted",
        reportSubmittedContext({
          reviewerName: reviewer.name,
          reportNumber: report.number,
          concernSummary,
          immediateRisk: report.immediateRisk,
          reviewLink,
        })
      );
      await notify(prisma, {
        type: "incidents.report_submitted",
        person: { id: reviewer.id, entraObjectId: reviewer.entraObjectId, contactEmail: reviewer.contactEmail },
        email: { subject: submittedRendered.subject, html: submittedRendered.html },
        teams: {
          title: `New incident report #${report.number}`,
          summary: report.immediateRisk
            ? `Incident report #${report.number} was submitted and flagged as an immediate risk (${concernSummary}).`
            : `Incident report #${report.number} was submitted (${concernSummary}).`,
          link: reviewLink,
        },
        triggeredById: actorPersonId,
      });

      if (report.strikeDecision === "PENDING" && subjectName) {
        const strikeRendered = await renderEmail(
          "incidents.strike_requested",
          strikeRequestedContext({
            reviewerName: reviewer.name,
            reportNumber: report.number,
            subjectName,
            reviewLink,
          })
        );
        await notify(prisma, {
          type: "incidents.strike_requested",
          person: { id: reviewer.id, entraObjectId: reviewer.entraObjectId, contactEmail: reviewer.contactEmail },
          email: { subject: strikeRendered.subject, html: strikeRendered.html },
          teams: {
            title: `Strike requested on incident report #${report.number}`,
            summary: `Incident report #${report.number} includes a request to issue a disciplinary strike against ${subjectName}.`,
            link: reviewLink,
          },
          triggeredById: actorPersonId,
        });
      }
    }
  } catch (err) {
    console.error("[incidents] failed to notify reviewers of a submitted report", report.id, err);
  }
}

/**
 * Tells the reporter that a reviewer approved or declined the strike they
 * requested on their report (incidents.strike_decided). The subject is never
 * a recipient. Best-effort: a delivery failure is logged and swallowed.
 */
async function notifyReporterOfStrikeDecision(
  report: IncidentReport,
  actorPersonId: string,
  approved: boolean
): Promise<void> {
  try {
    const reporter = await prisma.person.findUnique({
      where: { id: report.reporterId },
      select: { id: true, name: true, entraObjectId: true, contactEmail: true },
    });
    if (!reporter) return;

    const rendered = await renderEmail(
      "incidents.strike_decided",
      strikeDecidedContext({ reporterName: reporter.name, reportNumber: report.number, approved })
    );
    await notify(prisma, {
      type: "incidents.strike_decided",
      person: { id: reporter.id, entraObjectId: reporter.entraObjectId, contactEmail: reporter.contactEmail },
      email: { subject: rendered.subject, html: rendered.html },
      teams: {
        title: `Strike decision on incident report #${report.number}`,
        summary: approved
          ? `A reviewer approved the strike you requested on incident report #${report.number}.`
          : `A reviewer declined the strike you requested on incident report #${report.number}.`,
      },
      triggeredById: actorPersonId,
    });
  } catch (err) {
    console.error("[incidents] failed to notify the reporter of a strike decision", report.id, err);
  }
}

/**
 * Tells the reporter that their report was resolved or dismissed
 * (incidents.report_resolved). The subject is never a recipient. Best-effort:
 * a delivery failure is logged and swallowed.
 */
async function notifyReporterOfResolution(report: IncidentReport, actorPersonId: string): Promise<void> {
  try {
    const reporter = await prisma.person.findUnique({
      where: { id: report.reporterId },
      select: { id: true, name: true, entraObjectId: true, contactEmail: true },
    });
    if (!reporter) return;

    const baseUrl = await getSetting<string>("app.baseUrl");
    const reportLink = `${baseUrl}/incidents/${report.id}`;
    const approved = report.status === "RESOLVED";

    const rendered = await renderEmail(
      "incidents.report_resolved",
      reportResolvedContext({ reporterName: reporter.name, reportNumber: report.number, approved, reportLink })
    );
    await notify(prisma, {
      type: "incidents.report_resolved",
      person: { id: reporter.id, entraObjectId: reporter.entraObjectId, contactEmail: reporter.contactEmail },
      email: { subject: rendered.subject, html: rendered.html },
      teams: {
        title: `Incident report #${report.number} ${approved ? "resolved" : "dismissed"}`,
        summary: `Your incident report #${report.number} has been ${approved ? "resolved" : "dismissed"}.`,
        link: reportLink,
      },
      triggeredById: actorPersonId,
    });
  } catch (err) {
    console.error("[incidents] failed to notify the reporter of a report resolution", report.id, err);
  }
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
 *
 * Attachments (input.files): validated with validateUploadedFile (rules: null,
 * the uploads.maxMb global cap) BEFORE any attachment row is created, so a bad
 * file rejects the whole submission without leaving partial rows around --
 * the already-created report itself is left in place, matching how a plain
 * validation failure earlier in this function never touches the report row.
 * Each valid file then gets an IncidentReportAttachment row (storedName
 * "pending" -> derived from the row id -> putObject), mirroring the
 * create-row/derive-key/write-bytes pattern in my-info's saveCertificate. If
 * storage write fails partway through, every attachment row created during
 * this call is deleted before the error is rethrown, so the report never ends
 * up pointing at attachment rows with no bytes behind them -- and every blob
 * already written by an earlier file in the same call is also deleted, so a
 * later file's failure does not orphan the earlier files' bytes in storage.
 *
 * Notifications: after everything above commits, every incidents.manage
 * holder is alerted (incidents.report_submitted), plus a second
 * incidents.strike_requested alert when requestStrike landed the report at
 * strikeDecision PENDING. Delivery is best-effort (notifyReviewersOfSubmission
 * swallows and logs its own errors) so a notification failure never rolls
 * back or fails the submission.
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

  const files = input.files ?? [];
  if (files.length > 0) {
    // Validate every file before creating any attachment row, so a rejected
    // file never leaves a partial row behind.
    const maxMb = await getSetting<number>("uploads.maxMb");
    for (const file of files) {
      const problem = validateUploadedFile(file, null, maxMb);
      if (problem) throw new IncidentValidationError(problem.message);
    }

    const createdAttachmentIds: string[] = [];
    const uploadedStoredNames: string[] = [];
    try {
      for (const file of files) {
        const created = await prisma.incidentReportAttachment.create({
          data: {
            reportId: report.id,
            fileName: file.fileName,
            storedName: "pending",
            size: file.bytes.length,
            mimeType: file.mimeType,
            uploadedById: actorPersonId,
          },
        });
        createdAttachmentIds.push(created.id);

        const ext = path.extname(file.fileName).match(/^\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "";
        const storedName = `incidents/${report.id}/${created.id}${ext}`;
        await prisma.incidentReportAttachment.update({
          where: { id: created.id },
          data: { storedName },
        });

        await putObject(storedName, file.bytes, file.mimeType);
        uploadedStoredNames.push(storedName);
      }
    } catch (err) {
      // Storage (or an intervening DB write) failed: clean up every attachment
      // row created during this call so none point at bytes that were never
      // written, AND delete any blobs that were already uploaded earlier in
      // this loop so they don't become storage orphans with no DB row
      // pointing at them. The report itself is left in place.
      if (createdAttachmentIds.length > 0) {
        await prisma.incidentReportAttachment
          .deleteMany({ where: { id: { in: createdAttachmentIds } } })
          .catch((cleanupErr) => {
            console.error("[incidents] failed to clean up attachment rows after storage error", report.id, cleanupErr);
          });
      }
      if (uploadedStoredNames.length > 0) {
        await Promise.allSettled(
          uploadedStoredNames.map((storedName) =>
            deleteObject(storedName).catch((cleanupErr) => {
              console.error("[incidents] failed to clean up uploaded blob after storage error", report.id, storedName, cleanupErr);
            })
          )
        );
      }
      throw err;
    }
  }

  await notifyReviewersOfSubmission(report, actorPersonId);

  return report;
}

// ---------------------------------------------------------------------------
// Read: my reports and per-report visibility
// ---------------------------------------------------------------------------

export type ReportListRow = { report: IncidentReport; subjectName: string | null };

/**
 * A reporter's own reports, newest first. Secondary sort by number (a
 * monotonic autoincrement) so same-millisecond inserts still order
 * deterministically.
 */
export async function listMyReports(actorPersonId: string): Promise<ReportListRow[]> {
  const reports = await prisma.incidentReport.findMany({
    where: { reporterId: actorPersonId },
    include: { subject: { select: { name: true } } },
    orderBy: [{ createdAt: "desc" }, { number: "desc" }],
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
 * Ordered with immediateRisk reports first, then newest first, then by
 * number (a monotonic autoincrement) descending so same-millisecond inserts
 * still order deterministically. Paginated at REVIEW_PAGE_SIZE (25) rows per
 * page.
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
      orderBy: [{ immediateRisk: "desc" }, { createdAt: "desc" }, { number: "desc" }],
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
 *
 * When the new status is RESOLVED or DISMISSED, the reporter is notified
 * (incidents.report_resolved) via best-effort notifyReporterOfResolution
 * after the update and audit row commit; a delivery failure is logged and
 * swallowed, never rolling back this call. The subject is never notified.
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

  if (terminal) {
    await notifyReporterOfResolution(updated, actorPersonId);
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Strike decision (the report -> strike bridge)
// ---------------------------------------------------------------------------

export type DecideStrikeInput = {
  approve: boolean;
  category?: string;
  occurredAt?: Date | null;
  followUpActions?: string | null;
  policyReference?: string | null;
  notes?: string | null;
};

/**
 * Decides a report's pending strike request. Requires incidents.manage
 * (else IncidentForbiddenError). Missing report throws IncidentNotFoundError.
 * The report's strikeDecision must be PENDING, or IncidentValidationError.
 *
 * Decline: sets strikeDecision DECLINED, stamps strikeDecidedById/At. No
 * DisciplinaryAction is created.
 *
 * Approve: requires the report to have a subjectPersonId and a valid
 * category from DISCIPLINARY_CATEGORIES (else IncidentValidationError), then
 * calls issueAction against the subject with occurredAt defaulting to the
 * report's occurredAt (or now), description from the report, confidential
 * set to the report's anonymous flag (anonymous report -> confidential
 * strike, hidden from directors), patientInvolved from patientImpact, and
 * reportId linking the new strike back to this report. Then sets
 * strikeDecision APPROVED, stamping strikeDecidedById/At. Since
 * DisciplinaryAction.reportId is unique, a concurrent double-approve races
 * two issueAction calls; the loser's unique-constraint violation is caught
 * and rethrown as IncidentValidationError rather than an untyped 500.
 *
 * Both branches audit incident.strike_decided (entityType "IncidentReport",
 * after: { decision } -- approve also includes strikeActionId and
 * subjectPersonId) after the report row is updated.
 *
 * Either branch notifies the reporter (incidents.strike_decided, approved
 * mirrors the decision) via best-effort notifyReporterOfStrikeDecision after
 * its update commits; a delivery failure is logged and swallowed, never
 * rolling back this call. The subject is never notified.
 */
export async function decideStrike(
  actorPersonId: string,
  reportId: string,
  input: DecideStrikeInput
): Promise<IncidentReport> {
  if (!(await can(actorPersonId, "incidents.manage"))) throw new IncidentForbiddenError();

  const report = await prisma.incidentReport.findUnique({ where: { id: reportId } });
  if (!report) throw new IncidentNotFoundError();
  if (report.strikeDecision !== "PENDING") {
    throw new IncidentValidationError("This report has no pending strike request.");
  }

  if (!input.approve) {
    const declined = await prisma.incidentReport.update({
      where: { id: reportId },
      data: { strikeDecision: "DECLINED", strikeDecidedById: actorPersonId, strikeDecidedAt: new Date() },
    });

    await recordAudit({
      actorPersonId,
      action: "incident.strike_decided",
      entityType: "IncidentReport",
      entityId: reportId,
      after: { decision: "DECLINED" },
    });

    await notifyReporterOfStrikeDecision(declined, actorPersonId, false);
    return declined;
  }

  if (!report.subjectPersonId) {
    throw new IncidentValidationError("Cannot issue a strike: the report has no linked subject.");
  }
  const category = input.category ?? "";
  if (!(DISCIPLINARY_CATEGORIES as readonly string[]).includes(category)) {
    throw new IncidentValidationError(`Choose a strike category. One of: ${DISCIPLINARY_CATEGORIES.join(", ")}.`);
  }

  // issueAction enforces its own permission (incidents.manage -> central bypass).
  let strikeAction: DisciplinaryAction;
  try {
    strikeAction = await issueAction(actorPersonId, {
      personId: report.subjectPersonId,
      occurredAt: input.occurredAt ?? report.occurredAt ?? new Date(),
      category,
      description: report.description,
      followUpActions: input.followUpActions ?? null,
      policyReference: input.policyReference ?? null,
      notes: input.notes ?? null,
      confidential: report.anonymous, // anonymous report -> strike hidden from directors
      patientInvolved: report.patientImpact === "YES",
      reportId: report.id,
    });
  } catch (err) {
    // DisciplinaryAction.reportId is unique. A concurrent double-approve on
    // the same report races two issueAction calls; the loser hits a
    // unique-constraint violation here rather than surfacing as a raw 500.
    if (isUniqueConstraintError(err)) {
      throw new IncidentValidationError("A strike has already been issued for this report.");
    }
    throw err;
  }

  const approved = await prisma.incidentReport.update({
    where: { id: reportId },
    data: { strikeDecision: "APPROVED", strikeDecidedById: actorPersonId, strikeDecidedAt: new Date() },
  });

  await recordAudit({
    actorPersonId,
    action: "incident.strike_decided",
    entityType: "IncidentReport",
    entityId: reportId,
    after: { decision: "APPROVED", strikeActionId: strikeAction.id, subjectPersonId: report.subjectPersonId },
  });

  await notifyReporterOfStrikeDecision(approved, actorPersonId, true);
  return approved;
}
