/**
 * The clarification thread on an incident report: a reviewer asking the reporter
 * for more detail, and the reporter answering.
 *
 * Why this exists as its own surface rather than as email: reviewers had no way
 * to ask a follow-up question at all, and the obvious workaround -- emailing the
 * reporter directly -- takes the exchange outside the report it belongs to, out
 * of the audit trail, and (for a report the reporter asked to keep quiet) into a
 * mailbox with no access control. Everything here stays on the report.
 *
 * WHAT THIS IS NOT: a general comment log. Reviewer-to-reviewer notes live in
 * IncidentReport.reviewNotes, which the reporter never sees. Every message in
 * this thread is visible to BOTH sides by construction, so nothing may be
 * written here that the reporter should not read.
 *
 * Anonymity, precisely: `IncidentReport.anonymous` means anonymous to the
 * SUBJECT (and, through the confidential strike flag, to directors). Reviewers
 * have always seen the reporter's name -- the report form tells the reporter so
 * in as many words (see app/(app)/incidents/disclosure.ts). So this thread does
 * not need an identity-blind relay; a reviewer already knows who they are
 * asking. What it does need, and enforces, is that the SUBJECT of the report
 * never reaches it: see resolveReportAccess, which every function below gates
 * on, and which drops a subject even when they hold incidents.manage.
 */

import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { log, errorAttrs } from "@/platform/logging";
import { can } from "@/platform/rbac/engine";
import { getSetting } from "@/platform/settings/service";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { infoRequestedContext, infoProvidedContext } from "@/platform/email/templates/incidents";
import {
  IncidentForbiddenError,
  IncidentNotFoundError,
  IncidentValidationError,
  incidentAudience,
} from "./report";
import { resolveReportAccess } from "./report-access";

/** Longest single message. Generous for a real answer, short of a paste bomb. */
const MAX_BODY = 5000;

/**
 * The statuses a reviewer's question may move a report out of. A RESOLVED or
 * DISMISSED report is deliberately absent: asking a question must not silently
 * reopen a closed matter behind the resolving reviewer's back. Reopen it through
 * the status control first, which records who did it.
 */
const OPEN_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "AWAITING_INFO"] as const;

export type ReportMessage = {
  id: string;
  body: string;
  createdAt: Date;
  authorName: string;
  /**
   * True when this message came from the person who filed the report. Derived
   * from authorId, never stored -- a stored copy could disagree with the report.
   */
  fromReporter: boolean;
};

/**
 * Loads the report and the actor's standing on it, or throws. Shared by all
 * three entry points so none of them can be reached with a weaker check than
 * the others.
 */
async function loadForActor(actorPersonId: string, reportId: string) {
  const report = await prisma.incidentReport.findUnique({
    where: { id: reportId },
    select: {
      id: true,
      number: true,
      status: true,
      reporterId: true,
      subjects: { select: { personId: true } },
    },
  });
  if (!report) throw new IncidentNotFoundError();

  const canManage = await can(actorPersonId, "incidents.manage");
  const access = resolveReportAccess(report, actorPersonId, canManage);
  if (!access) throw new IncidentForbiddenError();

  return { report, access };
}

/** Trim, reject empty, reject over-long. */
function validateBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new IncidentValidationError("Enter a message.");
  if (trimmed.length > MAX_BODY) {
    throw new IncidentValidationError(`Keep the message under ${MAX_BODY} characters.`);
  }
  return trimmed;
}

/**
 * The thread on one report, oldest first, for the reporter or a non-subject
 * reviewer. Anyone else throws IncidentForbiddenError.
 */
export async function listMessages(
  actorPersonId: string,
  reportId: string
): Promise<ReportMessage[]> {
  const { report } = await loadForActor(actorPersonId, reportId);

  const rows = await prisma.incidentReportMessage.findMany({
    where: { reportId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      body: true,
      createdAt: true,
      authorId: true,
      author: { select: { name: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    createdAt: r.createdAt,
    authorName: r.author.name,
    fromReporter: r.authorId === report.reporterId,
  }));
}

/**
 * A reviewer asks the reporter for more information: records the message, moves
 * the report to AWAITING_INFO, and points the reporter at it.
 *
 * Requires effectiveManage, so a subject of the report can never send one even
 * holding incidents.manage. Also refuses when the actor IS the reporter -- there
 * is no one to ask, and the resulting row would render as a reporter message
 * while having flipped the status as though it were a question.
 */
export async function postReviewerQuestion(
  actorPersonId: string,
  reportId: string,
  body: string
): Promise<void> {
  const { report, access } = await loadForActor(actorPersonId, reportId);
  if (!access.effectiveManage) throw new IncidentForbiddenError();
  if (access.isOwner) {
    throw new IncidentValidationError("You filed this report, so there is no one to ask.");
  }
  const trimmed = validateBody(body);

  if (!(OPEN_STATUSES as readonly string[]).includes(report.status)) {
    throw new IncidentValidationError(
      "This report is closed. Set it back to under review before asking the reporter for more information."
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.incidentReportMessage.create({
      data: { reportId, authorId: actorPersonId, body: trimmed },
    });
    // Conditional updateMany, not update: the status precondition means a
    // reviewer resolving this report in the same moment wins, and the question
    // lands on a closed report rather than silently reopening it.
    await tx.incidentReport.updateMany({
      where: { id: reportId, status: { in: [...OPEN_STATUSES] } },
      data: { status: "AWAITING_INFO" },
    });
  });

  // Metadata only. The body is on the report, readable by exactly the two people
  // entitled to it; copying it into the audit log widens that set to every
  // admin who can read audit rows.
  await recordAudit({
    actorPersonId,
    action: "incident.info_requested",
    entityType: "IncidentReport",
    entityId: reportId,
    after: { number: report.number },
  });

  await notifyReporter(reportId, report.reporterId, report.number, actorPersonId);
}

/**
 * The reporter adds information: records the message, and returns the report to
 * UNDER_REVIEW **only if** it was AWAITING_INFO, so an unprompted addition to an
 * already-resolved report is recorded without reopening it.
 *
 * Requires ownership. A reporter may post without having been asked -- the
 * commonest real case is remembering a detail an hour after filing.
 */
export async function postReporterMessage(
  actorPersonId: string,
  reportId: string,
  body: string
): Promise<void> {
  const { report, access } = await loadForActor(actorPersonId, reportId);
  if (!access.isOwner) throw new IncidentForbiddenError();
  const trimmed = validateBody(body);

  await prisma.$transaction(async (tx) => {
    await tx.incidentReportMessage.create({
      data: { reportId, authorId: actorPersonId, body: trimmed },
    });
    // Narrow claim: only AWAITING_INFO advances. A reply on a RESOLVED report
    // must not resurrect it, and a reply on an UNDER_REVIEW report has nothing
    // to change.
    await tx.incidentReport.updateMany({
      where: { id: reportId, status: "AWAITING_INFO" },
      data: { status: "UNDER_REVIEW" },
    });
  });

  await recordAudit({
    actorPersonId,
    action: "incident.info_provided",
    entityType: "IncidentReport",
    entityId: reportId,
    after: { number: report.number },
  });

  await notifyReviewers(
    reportId,
    report.number,
    report.subjects.map((s) => s.personId),
    actorPersonId
  );
}

// ---------------------------------------------------------------------------
// Notifications (best-effort -- never throws out of a committed mutation)
// ---------------------------------------------------------------------------

/** Points the reporter at their report. Carries no case detail. */
async function notifyReporter(
  reportId: string,
  reporterId: string,
  reportNumber: number,
  actorPersonId: string
): Promise<void> {
  try {
    const reporter = await prisma.person.findUnique({
      where: { id: reporterId },
      select: { id: true, name: true, entraObjectId: true, contactEmail: true },
    });
    if (!reporter) return;

    const baseUrl = await getSetting<string>("app.baseUrl");
    const reportLink = `${baseUrl}/incidents/${reportId}`;
    const rendered = await renderEmail(
      "incidents.info_requested",
      infoRequestedContext({ reporterName: reporter.name, reportNumber, reportLink })
    );
    await notify(prisma, {
      type: "incidents.info_requested",
      person: { id: reporter.id, entraObjectId: reporter.entraObjectId, contactEmail: reporter.contactEmail },
      email: { subject: rendered.subject, html: rendered.html },
      teams: {
        title: `Question about incident report #${reportNumber}`,
        summary: `A reviewer has a question about incident report #${reportNumber}. Sign in to read it and reply.`,
        link: reportLink,
      },
      triggeredById: actorPersonId,
    });
  } catch (err) {
    log.error("[incidents] failed to notify the reporter of an information request", errorAttrs(err, { reportId }));
  }
}

/** Tells reviewers the reporter answered. Carries no case detail. */
async function notifyReviewers(
  reportId: string,
  reportNumber: number,
  subjectPersonIds: string[],
  actorPersonId: string
): Promise<void> {
  try {
    // Same subject exclusion notifyReviewersOfSubmission applies: a subject who
    // holds incidents.manage must never be told anything about a report naming
    // them, including that it just gained new information.
    const reviewers = (await incidentAudience()).filter((r) => !subjectPersonIds.includes(r.id));
    if (reviewers.length === 0) return;

    const baseUrl = await getSetting<string>("app.baseUrl");
    const reviewLink = `${baseUrl}/incidents/review`;

    for (const reviewer of reviewers) {
      const rendered = await renderEmail(
        "incidents.info_provided",
        infoProvidedContext({ reviewerName: reviewer.name, reportNumber, reviewLink })
      );
      await notify(prisma, {
        type: "incidents.info_provided",
        person: { id: reviewer.id, entraObjectId: reviewer.entraObjectId, contactEmail: reviewer.contactEmail },
        email: { subject: rendered.subject, html: rendered.html },
        teams: {
          title: `New information on incident report #${reportNumber}`,
          summary: `The reporter has added information to incident report #${reportNumber}.`,
          link: reviewLink,
        },
        triggeredById: actorPersonId,
      });
    }
  } catch (err) {
    log.error("[incidents] failed to notify reviewers of new report information", errorAttrs(err, { reportId }));
  }
}
