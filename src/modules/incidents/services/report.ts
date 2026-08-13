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
import { log, errorAttrs } from "@/platform/logging";
import { manageableDepartmentIds } from "@/platform/departments";
import { getActiveTerm } from "@/platform/terms/active-term";
import { can } from "@/platform/rbac/engine";
import { getSetting } from "@/platform/settings/service";
import { putObject, deleteObject } from "@/platform/storage";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatForDateInput } from "@/platform/dates/format";
import { formatDateOnly } from "@/platform/dates";
import { validateUploadedFile } from "@/modules/recruitment/services/upload";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { notify } from "@/platform/notifications/notify";
import { queueEmail } from "@/platform/email/send";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import {
  reportSubmittedContext,
  strikeRequestedContext,
  strikeDecidedContext,
  reportResolvedContext,
} from "@/platform/email/templates/incidents";
import { issueAction, DISCIPLINARY_CATEGORIES } from "./disciplinary";
import { notifyStrikeIssued } from "./strike-notifications";

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
  /** Why the reporter wants to stay anonymous to the subject. Ignored unless
   *  `anonymous` is set, so unchecking the box cannot leave orphaned text. */
  anonymousReason?: string | null;
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
// Audience
// ---------------------------------------------------------------------------

/** A person who receives incident notifications, and whether they can act. */
export type IncidentAudienceMember = {
  id: string;
  name: string;
  entraObjectId: string | null;
  contactEmail: string | null;
  /**
   * True for incidents.manage holders, who can open the review queue. False for
   * escalation-only recipients, whose emails must omit the review link rather
   * than offer one that bounces them off a page they cannot see.
   */
  canReview: boolean;
};

/**
 * Everyone who receives incident notifications: incidents.manage reviewers, plus
 * incidents.escalation_recipient holders copied for visibility.
 *
 * THE SINGLE SOURCE OF THIS AUDIENCE. The reporting form promises the reporter
 * "This report goes to the clinic's incident reviewers, currently N people", and
 * disclosure.ts requires that count to come from the same query that drives the
 * notification, so the form can never describe a smaller audience than the one
 * actually mailed. Every caller that notifies, or that counts in order to state
 * who is notified, must go through here. Do not reintroduce a bare
 * peopleWithAnyPermission(["incidents.manage"]) at a call site.
 *
 * Escalation recipients get NO read access anywhere; the permission exists only
 * to widen this list. See the note on the incidents module's permissions.
 */
/**
 * Clinical supervisors OUTSIDE the Hub who are copied on incidents.
 *
 * These are real people with no Person record and no account: Yale School of
 * Medicine attendings who need visibility but never sign in. That rules out the
 * permission mechanism (nothing to grant it to) and the notify() path (no
 * Person, so no Notification row and no channel preference). They get plain
 * email and nothing else.
 *
 * Parsed permissively (comma or whitespace separated, deduped, lowercased) and
 * filtered to values containing "@", so a stray trailing comma cannot produce an
 * empty recipient that fails at send time.
 */
export async function externalEscalationEmails(): Promise<string[]> {
  const raw = await getSetting<string>("incidents.externalEscalationEmails");
  const parts = (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes("@"));
  return [...new Set(parts)];
}

export async function incidentAudience(): Promise<IncidentAudienceMember[]> {
  const [reviewers, escalation] = await Promise.all([
    peopleWithAnyPermission(["incidents.manage"]),
    peopleWithAnyPermission(["incidents.escalation_recipient"]),
  ]);
  const reviewerIds = new Set(reviewers.map((r) => r.id));
  const members: IncidentAudienceMember[] = reviewers.map((r) => ({
    id: r.id,
    name: r.name,
    entraObjectId: r.entraObjectId,
    contactEmail: r.contactEmail,
    canReview: true,
  }));
  // Someone holding both permissions is a reviewer: the stronger role wins, and
  // they must not be mailed twice.
  for (const e of escalation) {
    if (reviewerIds.has(e.id)) continue;
    members.push({
      id: e.id,
      name: e.name,
      entraObjectId: e.entraObjectId,
      contactEmail: e.contactEmail,
      canReview: false,
    });
  }
  return members;
}

// ---------------------------------------------------------------------------
// Notifications (best-effort -- never throws out of a committed mutation)
// ---------------------------------------------------------------------------

/**
 * Alerts every incidents.manage holder that a report was just submitted
 * (incidents.report_submitted), and, when the report also carries at least
 * one pending strike request, alerts the same reviewers a second time
 * (incidents.strike_requested), naming every flagged person. Every linked
 * subject of the report (subjectPersonIds) is removed from the reviewer set
 * first, so a subject who also holds incidents.manage never receives an alert
 * about a report concerning them (they could otherwise unmask an anonymous
 * reporter or learn of a pending strike against themselves). Called after the
 * report row (and any attachments) commit; a delivery failure is logged and
 * swallowed so it can never roll back or throw out of submitReport.
 */
async function notifyReviewersOfSubmission(
  report: IncidentReport,
  subjectPersonIds: string[],
  pendingSubjectNames: string[],
  actorPersonId: string
): Promise<void> {
  try {
    // Exclude every linked subject from the audience, even one who requested no
    // strike, so no subject is ever alerted about a report about themselves.
    // Applies to escalation recipients too: being copied for visibility must not
    // become a way to learn of a report against yourself.
    const reviewers = (await incidentAudience()).filter(
      (r) => !subjectPersonIds.includes(r.id)
    );
    // Deliberately NOT an early return. External supervisors are an independent
    // audience: if nobody currently holds incidents.manage, they are the only
    // people who would hear about the report at all, and returning here would
    // silently drop them too.

    const baseUrl = await getSetting<string>("app.baseUrl");
    const reviewQueueUrl = `${baseUrl}/incidents/review`;
    const concernSummary = report.concernTypes.map((c) => CONCERN_LABELS[c] ?? c).join(", ");
    const hasStrikeRequest = pendingSubjectNames.length > 0;
    const subjectNames = pendingSubjectNames.join(", ");

    for (const reviewer of reviewers) {
      // Escalation-only recipients get the substance without a link: the review
      // queue requires incidents.manage, so offering it would send them to a
      // no-access page. The templates guard the link paragraph on a non-empty
      // value, so passing "" omits it rather than shipping a dead anchor.
      const reviewLink = reviewer.canReview ? reviewQueueUrl : "";
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
          // `|| null` not `??`: the template path uses "" for an escalation-only
          // recipient, and an empty string would otherwise be stored as a
          // clickable-but-empty Teams action.
          link: reviewLink || null,
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

    // --- External clinical supervisors ---
    //
    // Sent LAST and guarded hardest. These addresses are outside the clinic
    // entirely, so an anonymous report must never reach them: the reporter was
    // promised anonymity toward the subject, and a narrative leaving the
    // organization is the one disclosure that cannot be walked back.
    //
    // They also get no link, because they have no account to follow it with,
    // and no verbatim description, because the point is visibility that an
    // incident occurred rather than distribution of the account.
    if (!report.anonymous) {
      const externals = await externalEscalationEmails();
      for (const to of externals) {
        const rendered = await renderEmail(
          "incidents.report_submitted",
          reportSubmittedContext({
            reviewerName: "Colleague",
            reportNumber: report.number,
            concernSummary,
            immediateRisk: report.immediateRisk,
            reviewLink: "",
          })
        );
        await queueEmail(prisma, {
          to,
          subject: rendered.subject,
          html: rendered.html,
          template: "incidents.report_submitted",
          // No personId: there is no Person behind this address. EmailLog still
          // records the send, which is what makes the disclosure auditable.
          triggeredById: actorPersonId,
        });
      }
    }
  } catch (err) {
    log.error("[incidents] failed to notify reviewers of a submitted report", errorAttrs(err, { reportId: report.id }));
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
    log.error("[incidents] failed to notify the reporter of a strike decision", errorAttrs(err, { reportId: report.id }));
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
    log.error("[incidents] failed to notify the reporter of a report resolution", errorAttrs(err, { reportId: report.id }));
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
 * the uploads.maxMb global cap) BEFORE the report row is created, alongside the
 * field and subject validations above, so a bad file rejects the whole
 * submission before any report row exists and before any reviewer is notified
 * (never orphaning a committed report behind a failed attachment validation).
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
 * holder except a linked subject of this report is alerted
 * (incidents.report_submitted), plus a second incidents.strike_requested
 * alert naming every subject whose strike request landed at PENDING, when
 * there is at least one. Excluding linked subjects keeps a subject who also
 * holds incidents.manage from being alerted about a report concerning them.
 * Delivery is best-effort (notifyReviewersOfSubmission swallows and logs its
 * own errors) so a notification failure never rolls back or fails the submission.
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

  // Validate every uploaded file BEFORE the report row is created (next to the
  // field and subject validations above), so an invalid attachment rejects the
  // submission without ever committing a report row or notifying a reviewer.
  const files = input.files ?? [];
  if (files.length > 0) {
    const maxMb = await getSetting<number>("uploads.maxMb");
    for (const file of files) {
      const problem = validateUploadedFile(file, null, maxMb);
      if (problem) throw new IncidentValidationError(problem.message);
    }
  }

  const report = await prisma.incidentReport.create({
    data: {
      reporterId: actorPersonId,
      anonymous: input.anonymous ?? false,
      // Only stored alongside a live anonymity request. A reporter who typed a
      // reason and then unchecked the box must not leave the explanation behind
      // on a report that is not anonymous, where it would read as an unexplained
      // aside about a colleague.
      anonymousReason: input.anonymous ? (input.anonymousReason?.trim() || null) : null,
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

  if (files.length > 0) {
    // Files were already validated before the report row was created above.
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
            log.error("[incidents] failed to clean up attachment rows after storage error", errorAttrs(cleanupErr, { reportId: report.id }));
          });
      }
      if (uploadedStoredNames.length > 0) {
        await Promise.allSettled(
          uploadedStoredNames.map((storedName) =>
            deleteObject(storedName).catch((cleanupErr) => {
              log.error("[incidents] failed to clean up uploaded blob after storage error", errorAttrs(cleanupErr, { reportId: report.id, storedName }));
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

  // Exclude every linked subject (not only strike-flagged ones) from the
  // reviewer alerts, so a subject who also holds incidents.manage is never
  // notified about a report concerning them.
  const subjectPersonIds = subjects.map((s) => s.personId);
  await notifyReviewersOfSubmission(report, subjectPersonIds, pendingSubjectNames, actorPersonId);

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

  const actorIsSubject = report.subjects.some((s) => s.personId === actorPersonId);

  // A linked subject who merely holds incidents.manage must never reach a report
  // about themselves through that capability (they could unmask an anonymous
  // reporter or self-adjudicate). Reaching here with !isOwner implies canManage,
  // so this only blocks the manage path; the reporter-owner read path is unaffected.
  if (!isOwner && actorIsSubject) {
    throw new IncidentForbiddenError();
  }

  // Even on the owner (self-report) path, a linked subject must not exercise manage
  // powers over a report about themselves: reviewReport/decideStrike both reject a
  // subject server-side, so returning canManage=true here would leak reviewNotes to
  // them and render dead-end reviewer controls. Exclude subjects from the effective
  // manage flag used for both.
  const effectiveManage = canManage && !actorIsSubject;
  const safe = effectiveManage ? report : { ...report, reviewNotes: null };
  return { report: safe, canManage: effectiveManage };
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

// ---------------------------------------------------------------------------
// Strike-linking (report picker for the Strikes page)
// ---------------------------------------------------------------------------

/** How many reports the strike-linking picker offers. */
const LINKABLE_REPORT_LIMIT = 200;

/**
 * Reports a central reviewer may link a strike to, newest first, for the
 * Combobox on the Strikes page.
 *
 * Requires incidents.manage -> IncidentForbiddenError. Capped at
 * LINKABLE_REPORT_LIMIT: the Combobox filters client-side over whatever it is
 * given, so this deliberately does not ship the full history. Older reports are
 * linked by deleting and re-recording the strike, or by raising the cap.
 * Ordered by number (a monotonic autoincrement) as a secondary key so
 * same-millisecond inserts still order deterministically.
 */
export async function linkableReports(
  actorPersonId: string
): Promise<Array<{ id: string; label: string }>> {
  if (!(await can(actorPersonId, "incidents.manage"))) throw new IncidentForbiddenError();

  const zone = await getDisplayTimeZone();
  const reports = await prisma.incidentReport.findMany({
    select: { id: true, number: true, concernTypes: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { number: "desc" }],
    take: LINKABLE_REPORT_LIMIT,
  });

  return reports.map((r) => {
    const concerns = r.concernTypes.map((c) => CONCERN_LABELS[c] ?? c).join(", ");
    const date = formatDateOnly(r.createdAt, zone, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return { id: r.id, label: `#${r.number} -- ${concerns} -- ${date}` };
  });
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
  // Only treat this as a fresh resolution when the status actually CHANGES to a
  // terminal value. Re-saving an already-terminal report (e.g. editing reviewNotes
  // with the Status select still on RESOLVED) must not re-notify the reporter nor
  // reset the original decision timestamp; it keeps the existing resolver/date.
  const statusChanged = input.status !== existing.status;
  const resolvedNow = terminal && statusChanged;
  const updated = await prisma.incidentReport.update({
    where: { id },
    data: {
      status: input.status,
      reviewNotes: input.reviewNotes === undefined ? existing.reviewNotes : input.reviewNotes,
      resolvedById: terminal ? (resolvedNow ? actorPersonId : existing.resolvedById) : null,
      resolvedAt: terminal ? (resolvedNow ? new Date() : existing.resolvedAt) : null,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "incident.review",
    entityType: "IncidentReport",
    entityId: id,
    after: { status: updated.status },
  });

  if (resolvedNow) {
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
  // A linked subject of the report may never decide ANY strike on it, even holding
  // incidents.manage and even against a co-subject (mirrors reviewReport). The prior
  // `subject.personId === actorPersonId` check only blocked the actor's own row, so a
  // reviewer who was a co-subject of a multi-subject report could adjudicate a peer's
  // strike on a report they are otherwise barred from viewing.
  const actorIsSubject = await prisma.incidentReportSubject.findFirst({
    where: { reportId: subject.reportId, personId: actorPersonId },
    select: { id: true },
  });
  if (actorIsSubject) throw new IncidentForbiddenError();
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

  // #96: DisciplinaryAction.occurredAt is a calendar-day column -- every other
  // write stores a UTC-midnight marker parsed from an <input type="date"> and every
  // read renders it with <CalendarDate timeZone:"UTC">. A raw `new Date()` fallback
  // stores a live instant, so an approval at (say) 21:15 ET is 01:15Z the next day
  // and the register shows the strike one day late. Fall back to today's calendar
  // day in the display zone, anchored at UTC midnight, consistent with the column.
  const occurredFallback = new Date(
    `${formatForDateInput(new Date(), await getDisplayTimeZone())}T00:00:00.000Z`,
  );

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
          occurredAt: input.occurredAt ?? report.occurredAt ?? occurredFallback,
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

  // The subject, and their directors unless the strike is confidential. Runs
  // after the transaction commits, so a rollback never mails anyone. The subject
  // email's anonymity protection (#45 -- never send an anonymous reporter's verbatim
  // narrative to the subject) lives inside notifyStrikeIssued, driven by the strike's
  // notes/confidential fields, so both the report path and the ledger path get it.
  await notifyStrikeIssued({ action: strikeAction, actorPersonId });

  return approved;
}
