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
  IncidentReportSubject,
  IncidentReportStatus,
  PatientImpact,
  IssueNature,
  PriorOccurrence,
  Prisma,
  DisciplinaryAction,
  StrikeDecision,
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
import { queueEmail } from "@/platform/email/send";
import { renderTemplate } from "@/platform/email/render/render";
import { getDescriptor } from "@/platform/email/templates/registry";

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
  subjects?: Array<{ personId: string; requestStrike?: boolean }>;
  subjectDescription?: string | null;
  patientImpact?: PatientImpact | null;
  patientImpactDetail?: string | null;
  immediateRisk?: boolean;
  issueNature?: IssueNature | null;
  priorOccurrence?: PriorOccurrence | null;
  priorOccurrenceDetail?: string | null;
  anonymous?: boolean;
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
 * (incidents.report_submitted), and, when the report also carries at least
 * one pending strike request, alerts the same reviewers a second time
 * (incidents.strike_requested), naming every flagged person. The subject(s)
 * are never a recipient here -- only reviewers. Called after the report row
 * (and any attachments) commit; a delivery failure is logged and swallowed so
 * it can never roll back or throw out of submitReport.
 */
async function notifyReviewersOfSubmission(
  report: IncidentReport,
  pendingSubjectNames: string[],
  actorPersonId: string
): Promise<void> {
  try {
    const reviewers = await peopleWithAnyPermission(["incidents.manage"]);
    if (reviewers.length === 0) return;

    const baseUrl = await getSetting<string>("app.baseUrl");
    const reviewLink = `${baseUrl}/incidents/review`;
    const concernSummary = report.concernTypes.map((c) => CONCERN_LABELS[c] ?? c).join(", ");
    const hasStrikeRequest = pendingSubjectNames.length > 0;
    const subjectNames = pendingSubjectNames.join(", ");

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

      if (hasStrikeRequest) {
        const strikeRendered = await renderEmail(
          "incidents.strike_requested",
          strikeRequestedContext({
            reviewerName: reviewer.name,
            reportNumber: report.number,
            subjectNames,
            reviewLink,
          })
        );
        await notify(prisma, {
          type: "incidents.strike_requested",
          person: { id: reviewer.id, entraObjectId: reviewer.entraObjectId, contactEmail: reviewer.contactEmail },
          email: { subject: strikeRendered.subject, html: strikeRendered.html },
          teams: {
            title: `Strike requested on incident report #${report.number}`,
            summary: `Incident report #${report.number} includes a request to issue a disciplinary strike against ${subjectNames}.`,
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
 *   - a subject's requestStrike requires canRequestStrikeAgainst(actor, that subject).
 *
 * input.subjects (deduped by personId; a person requests a strike if any
 * duplicate did) creates one IncidentReportSubject row per linked person, each
 * strike-flagged one at strikeDecision PENDING. Every linked personId must
 * reference an existing Person (IncidentNotFoundError otherwise).
 *
 * Audits incident.submit (entityType "IncidentReport", after:
 * { number, concernTypes, immediateRisk, strikeRequested }) -- strikeRequested
 * is true when any linked subject requested a strike.
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
 * incidents.strike_requested alert naming every subject whose strike request
 * landed at PENDING, when there is at least one. Delivery is best-effort
 * (notifyReviewersOfSubmission swallows and logs its own errors) so a
 * notification failure never rolls back or fails the submission.
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

  // Dedupe subjects by personId; a person requests a strike if any duplicate did.
  const subjectMap = new Map<string, boolean>();
  for (const s of input.subjects ?? []) {
    subjectMap.set(s.personId, (subjectMap.get(s.personId) ?? false) || Boolean(s.requestStrike));
  }
  const subjects = [...subjectMap.entries()].map(([personId, requestStrike]) => ({ personId, requestStrike }));

  // Every linked person must exist.
  for (const s of subjects) {
    const person = await prisma.person.findUnique({ where: { id: s.personId } });
    if (!person) throw new IncidentNotFoundError(`Subject ${s.personId} not found.`);
  }

  // A strike may only be requested against a volunteer in a department the actor
  // manages. The UI only offers the checkbox for eligible people; this is the
  // server-side tamper guard.
  for (const s of subjects) {
    if (s.requestStrike && !(await canRequestStrikeAgainst(actorPersonId, s.personId))) {
      throw new IncidentValidationError("You can only request a strike for a volunteer in a department you manage.");
    }
  }
  const strikeRequested = subjects.some((s) => s.requestStrike);

  const report = await prisma.incidentReport.create({
    data: {
      reporterId: actorPersonId,
      anonymous: input.anonymous ?? false,
      concernTypes,
      description: input.description,
      occurredAt: input.occurredAt ?? null,
      setting: input.setting ?? null,
      subjectDescription: input.subjectDescription ?? null,
      patientImpact: input.patientImpact ?? null,
      patientImpactDetail: input.patientImpactDetail ?? null,
      immediateRisk: input.immediateRisk ?? false,
      issueNature: input.issueNature ?? null,
      priorOccurrence: input.priorOccurrence ?? null,
      priorOccurrenceDetail: input.priorOccurrenceDetail ?? null,
      subjects: {
        create: subjects.map((s) => ({
          personId: s.personId,
          strikeDecision: s.requestStrike ? ("PENDING" as const) : null,
        })),
      },
    },
  });

  await recordAudit({
    actorPersonId,
    action: "incident.submit",
    entityType: "IncidentReport",
    entityId: report.id,
    after: { number: report.number, concernTypes, immediateRisk: report.immediateRisk, strikeRequested },
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

  const strikePersonIds = subjects.filter((s) => s.requestStrike).map((s) => s.personId);
  const pendingSubjectNames =
    strikePersonIds.length === 0
      ? []
      : (
          await prisma.person.findMany({
            where: { id: { in: strikePersonIds } },
            select: { name: true },
          })
        ).map((p) => p.name);

  await notifyReviewersOfSubmission(report, pendingSubjectNames, actorPersonId);

  return report;
}

// ---------------------------------------------------------------------------
// Read: my reports and per-report visibility
// ---------------------------------------------------------------------------

type SubjectWithName = { strikeDecision: StrikeDecision | null; person: { name: string } };

/** Derive display names + strike counts from a report's linked subjects. */
function summarizeSubjects(subjects: SubjectWithName[]): {
  subjectNames: string[];
  strikePendingCount: number;
  strikeIssuedCount: number;
} {
  return {
    subjectNames: subjects.map((s) => s.person.name),
    strikePendingCount: subjects.filter((s) => s.strikeDecision === "PENDING").length,
    strikeIssuedCount: subjects.filter((s) => s.strikeDecision === "APPROVED").length,
  };
}

export type ReportListRow = {
  report: IncidentReport;
  subjectNames: string[];
  strikePendingCount: number;
  strikeIssuedCount: number;
};

/**
 * A reporter's own reports, newest first. Secondary sort by number (a
 * monotonic autoincrement) so same-millisecond inserts still order
 * deterministically.
 */
export async function listMyReports(actorPersonId: string): Promise<ReportListRow[]> {
  const reports = await prisma.incidentReport.findMany({
    where: { reporterId: actorPersonId },
    include: { subjects: { include: { person: { select: { name: true } } } } },
    orderBy: [{ createdAt: "desc" }, { number: "desc" }],
  });
  return reports.map((r) => ({ report: r, ...summarizeSubjects(r.subjects) }));
}

/**
 * A single report with its linked subjects, reporter, and attachments.
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
    subjects: Array<{ id: string; personId: string; strikeDecision: StrikeDecision | null; person: { name: string } }>;
    reporter: { name: string };
    attachments: IncidentReportAttachment[];
  };
  canManage: boolean;
}> {
  const report = await prisma.incidentReport.findUnique({
    where: { id },
    include: {
      subjects: { include: { person: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
      reporter: { select: { name: true } },
      attachments: true,
    },
  });
  if (!report) throw new IncidentNotFoundError();

  const canManage = await can(actorPersonId, "incidents.manage");
  const isOwner = report.reporterId === actorPersonId;
  if (!canManage && !isOwner) throw new IncidentForbiddenError();

  // A linked subject who merely holds incidents.manage must never reach a report
  // about themselves through that capability (they could unmask an anonymous
  // reporter or self-adjudicate). Reaching here with !isOwner implies canManage,
  // so this only blocks the manage path; the reporter-owner read path is unaffected.
  if (!isOwner && report.subjects.some((s) => s.personId === actorPersonId)) {
    throw new IncidentForbiddenError();
  }

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

/**
 * The real IncidentReportStatus enum values, used to validate the status filter
 * before it reaches Prisma. An unknown value (e.g. a hand-crafted query string)
 * is dropped rather than passed through, which would otherwise throw.
 */
const INCIDENT_REPORT_STATUSES: IncidentReportStatus[] = ["SUBMITTED", "UNDER_REVIEW", "RESOLVED", "DISMISSED"];

/** Largest value a Postgres int4 (IncidentReport.number) can hold. */
const MAX_INT4 = 2_147_483_647;

export type ReviewQueueRow = {
  report: IncidentReport;
  reporterName: string;
  subjectNames: string[];
  strikePendingCount: number;
  strikeIssuedCount: number;
};

/**
 * All incident reports, filtered and paginated for a reviewer. Requires
 * incidents.manage (else IncidentForbiddenError). Reports that link the
 * reviewer themselves as a subject are excluded, so a subject who holds
 * incidents.manage can never review a report about themselves.
 *
 * Filters: status (validated against IncidentReportStatus; an unknown value is
 * ignored), concernType (array contains), immediateRisk (true only),
 * strikePending (any linked subject's strikeDecision === PENDING), q
 * (case-insensitive match against any linked subject's name, reporter name, or
 * report number -- the numeric branch is only used when the digits fit a
 * Postgres int4, so an out-of-range value never overflows the number column).
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
  // Never surface a report about the reviewer to that same reviewer. `none`
  // keeps subject-less reports in the queue (no linked person matches). Extra
  // subject-relation conditions (strikePending, q) go through AND so they never
  // overwrite this exclusion.
  const where: Prisma.IncidentReportWhereInput = {
    subjects: { none: { personId: actorPersonId } },
  };
  if (filters.status && (INCIDENT_REPORT_STATUSES as string[]).includes(filters.status)) {
    where.status = filters.status as IncidentReportStatus;
  }
  if (filters.concernType) where.concernTypes = { has: filters.concernType };
  if (filters.immediateRisk) where.immediateRisk = true;

  const and: Prisma.IncidentReportWhereInput[] = [];
  if (filters.strikePending) and.push({ subjects: { some: { strikeDecision: "PENDING" } } });
  if (filters.q) {
    const q = filters.q.trim();
    const asNumber = Number.parseInt(q, 10);
    // Only match on the report number when the digits fit a Postgres int4. A
    // longer digit string overflows the `number` column and throws, so an
    // out-of-range value simply skips the numeric branch.
    const numMatch =
      Number.isFinite(asNumber) && asNumber >= 0 && asNumber <= MAX_INT4 ? [{ number: asNumber }] : [];
    and.push({
      OR: [
        { subjects: { some: { person: { name: { contains: q, mode: "insensitive" } } } } },
        { reporter: { name: { contains: q, mode: "insensitive" } } },
        ...numMatch,
      ],
    });
  }
  if (and.length > 0) where.AND = and;

  const [reports, total] = await Promise.all([
    prisma.incidentReport.findMany({
      where,
      include: {
        subjects: { include: { person: { select: { name: true } } } },
        reporter: { select: { name: true } },
      },
      orderBy: [{ immediateRisk: "desc" }, { createdAt: "desc" }, { number: "desc" }],
      skip: (page - 1) * REVIEW_PAGE_SIZE,
      take: REVIEW_PAGE_SIZE,
    }),
    prisma.incidentReport.count({ where }),
  ]);

  return {
    rows: reports.map((r) => ({ report: r, reporterName: r.reporter.name, ...summarizeSubjects(r.subjects) })),
    total,
  };
}

/**
 * Sets a report's status and reviewer notes. Requires incidents.manage
 * (else IncidentForbiddenError), and a reviewer who is a linked subject of the
 * report is forbidden so no one can adjudicate a report about themselves.
 * Missing report throws IncidentNotFoundError.
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
  // A linked subject of a report may never adjudicate it, even holding incidents.manage.
  const actorIsSubject = await prisma.incidentReportSubject.findFirst({
    where: { reportId: id, personId: actorPersonId },
    select: { id: true },
  });
  if (actorIsSubject) throw new IncidentForbiddenError();

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
 * Decides one linked person's pending strike request on a report. Requires
 * incidents.manage (else IncidentForbiddenError), and a reviewer who is that
 * linked subject is forbidden so no one can decide a strike on themselves.
 * Missing IncidentReportSubject row throws IncidentNotFoundError. That row's
 * strikeDecision must be PENDING, or IncidentValidationError.
 *
 * Both terminal transitions are an atomic claim: the subject-row write is an
 * updateMany gated on strikeDecision still being PENDING, and a count of 0
 * (a concurrent decision won the race) raises IncidentValidationError. This
 * keeps a concurrent approve+decline from ever leaving a DECLINED row with a
 * live strike behind it.
 *
 * Decline: claims strikeDecision DECLINED, stamps strikeDecidedById/At. No
 * DisciplinaryAction is created.
 *
 * Approve: requires a valid category from DISCIPLINARY_CATEGORIES (else
 * IncidentValidationError). The PENDING->APPROVED claim and the issueAction
 * strike create run inside one interactive transaction, so a lost claim rolls
 * the strike back. issueAction runs against that subject's personId with
 * occurredAt defaulting to the report's occurredAt (or now), description from
 * the report, confidential set to the report's anonymous flag (anonymous
 * report -> confidential strike, hidden from directors), patientInvolved from
 * patientImpact, and reportId linking the new strike back to this report.
 * Since DisciplinaryAction is unique per (reportId, personId), a double-approve
 * of the same subject that slips past the claim surfaces the loser's
 * unique-constraint violation, caught and rethrown as IncidentValidationError.
 * Deciding one subject's row never touches another subject's row on the same
 * report.
 *
 * Both branches audit incident.strike_decided (entityType "IncidentReport",
 * after: { decision } -- approve also includes strikeActionId,
 * reportSubjectId, and personId) after the subject row is updated.
 *
 * Either branch notifies the reporter (incidents.strike_decided, approved
 * mirrors the decision) via best-effort notifyReporterOfStrikeDecision after
 * its update commits; a delivery failure is logged and swallowed, never
 * rolling back this call. The linked people are never notified.
 */
export async function decideStrike(
  actorPersonId: string,
  reportSubjectId: string,
  input: DecideStrikeInput
): Promise<IncidentReportSubject> {
  if (!(await can(actorPersonId, "incidents.manage"))) throw new IncidentForbiddenError();

  const subject = await prisma.incidentReportSubject.findUnique({
    where: { id: reportSubjectId },
    include: { report: true },
  });
  if (!subject) throw new IncidentNotFoundError();
  // A linked subject may never decide a strike on themselves, even holding incidents.manage.
  if (subject.personId === actorPersonId) throw new IncidentForbiddenError();
  if (subject.strikeDecision !== "PENDING") {
    throw new IncidentValidationError("This linked person has no pending strike request.");
  }
  const report = subject.report;

  if (!input.approve) {
    // Atomic claim: only a still-PENDING subject row becomes DECLINED. If a
    // concurrent decision won first, count === 0 and we reject rather than
    // clobbering the decided state.
    const claim = await prisma.incidentReportSubject.updateMany({
      where: { id: reportSubjectId, strikeDecision: "PENDING" },
      data: { strikeDecision: "DECLINED", strikeDecidedById: actorPersonId, strikeDecidedAt: new Date() },
    });
    if (claim.count === 0) {
      throw new IncidentValidationError("This strike request was already decided.");
    }
    const declined = await prisma.incidentReportSubject.findUniqueOrThrow({ where: { id: reportSubjectId } });

    await recordAudit({
      actorPersonId,
      action: "incident.strike_decided",
      entityType: "IncidentReport",
      entityId: report.id,
      after: { decision: "DECLINED", reportSubjectId, personId: subject.personId },
    });

    await notifyReporterOfStrikeDecision(report, actorPersonId, false);
    return declined;
  }

  const category = input.category ?? "";
  if (!(DISCIPLINARY_CATEGORIES as readonly string[]).includes(category)) {
    throw new IncidentValidationError(`Choose a strike category. One of: ${DISCIPLINARY_CATEGORIES.join(", ")}.`);
  }

  // The PENDING->APPROVED claim and the issueAction strike create share one
  // interactive transaction: the claim runs first, so a lost race (count === 0)
  // throws before any strike is created, and any later failure rolls the claim
  // back. issueAction enforces its own permission (incidents.manage -> central bypass).
  let strikeAction: DisciplinaryAction;
  let approved: IncidentReportSubject;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const claim = await tx.incidentReportSubject.updateMany({
        where: { id: reportSubjectId, strikeDecision: "PENDING" },
        data: { strikeDecision: "APPROVED", strikeDecidedById: actorPersonId, strikeDecidedAt: new Date() },
      });
      if (claim.count === 0) {
        throw new IncidentValidationError("This strike request was already decided.");
      }
      const action = await issueAction(
        actorPersonId,
        {
          personId: subject.personId,
          occurredAt: input.occurredAt ?? report.occurredAt ?? new Date(),
          category,
          description: report.description,
          followUpActions: input.followUpActions ?? null,
          policyReference: input.policyReference ?? null,
          notes: input.notes ?? null,
          confidential: report.anonymous, // anonymous report -> strike hidden from directors
          patientInvolved: report.patientImpact === "YES",
          reportId: report.id,
        },
        tx
      );
      const row = await tx.incidentReportSubject.findUniqueOrThrow({ where: { id: reportSubjectId } });
      return { action, row };
    });
    strikeAction = result.action;
    approved = result.row;
  } catch (err) {
    // DisciplinaryAction is unique per (reportId, personId). A double-approve of
    // the same subject that slips past the atomic claim hits the composite unique
    // here (rolling the transaction back) rather than surfacing as a raw 500.
    if (isUniqueConstraintError(err)) {
      throw new IncidentValidationError("A strike has already been issued for this person on this report.");
    }
    throw err;
  }

  await recordAudit({
    actorPersonId,
    action: "incident.strike_decided",
    entityType: "IncidentReport",
    entityId: report.id,
    after: { decision: "APPROVED", strikeActionId: strikeAction.id, reportSubjectId, personId: subject.personId },
  });

  await notifyReporterOfStrikeDecision(report, actorPersonId, true);

  // Notify the subject that a strike has been officially issued against them.
  try {
    const descriptor = getDescriptor("incidents.strike_issued");
    if (descriptor) {
      const [volunteer, issuer] = await Promise.all([
        prisma.person.findUnique({
          where: { id: subject.personId },
          select: { name: true, contactEmail: true },
        }),
        prisma.person.findUnique({
          where: { id: actorPersonId },
          select: { name: true },
        }),
      ]);
      if (volunteer?.contactEmail) {
        const issuedDate = new Date().toLocaleDateString("en-US", {
          month: "long", day: "numeric", year: "numeric",
        });
        const html = renderTemplate(descriptor.defaultBody, {
          subjectName: volunteer.name?.split(" ")[0] ?? volunteer.name ?? "",
          category,
          description: report.description ?? "",
          issuedBy: issuer?.name ?? "HAVEN Directors",
          issuedDate,
        });
        const emailSubject = renderTemplate(descriptor.defaultSubject, {});
        await queueEmail(prisma, {
          to: volunteer.contactEmail,
          subject: emailSubject,
          html,
          template: "incidents.strike_issued",
          personId: subject.personId,
          triggeredById: actorPersonId,
        });
      }
    }
  } catch {
    // Best-effort notifications.
  }

  return approved;
}
