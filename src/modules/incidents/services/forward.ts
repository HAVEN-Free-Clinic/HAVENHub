/**
 * Forwarding an incident report, or an issued strike, to a clinical supervisor
 * outside the Hub.
 *
 * WHAT THIS REPLACES: every non-anonymous report and every non-confidential
 * strike used to be emailed automatically to EVERY address in
 * `incidents.externalEscalationEmails`. Nobody chose; the list was the policy.
 * Reviewers wanted the opposite -- to send a particular matter to a particular
 * supervisor -- so the automatic sends are gone (see report.ts and
 * strike-notifications.ts) and this is the deliberate act that replaced them.
 *
 * TWO RULES HOLD THE SAFETY THAT THE OLD BLIND COPY GOT FROM BEING AUTOMATIC:
 *
 *  1. Recipients must come from the configured directory. A free-typed address
 *     is one typo away from disclosing an incident report to a stranger, and no
 *     disclosure outside the organization can be recalled.
 *  2. Every forward is recorded on the record it disclosed (IncidentForward), not
 *     just in EmailLog. A reviewer deciding whether to forward needs to see who
 *     already received it, and an audit needs the trail attached to the report.
 *
 * The payload is deliberately thin -- report number, concern types, risk flag,
 * the reviewer's note -- with no link (recipients have no Hub account) and no
 * verbatim description. That thinness is what makes an ANONYMOUS report safe to
 * forward: the email never carries the reporter's name or their account of
 * events, so anonymity toward the subject survives the disclosure.
 */

import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { queueEmail } from "@/platform/email/send";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { forwardedExternalContext } from "@/platform/email/templates/incidents";
import { IncidentNotFoundError, IncidentForbiddenError, CONCERN_LABELS } from "./report";
import { externalContacts } from "./external-contacts";

/** A forward that cannot be sent as asked: no recipients, or an unknown address. */
export class IncidentForwardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncidentForwardError";
  }
}

export type ForwardInput = {
  /** Addresses chosen from the directory. */
  emails: string[];
  /** Optional covering note from the reviewer, included in the email. */
  note?: string;
};

const MANAGE = "incidents.manage";

/**
 * Resolves the requested addresses against the directory, or throws.
 *
 * Returns the matched contacts so the caller snapshots the display NAME as it
 * stood at send time: the directory is a free-text setting, and an entry can be
 * renamed or deleted afterwards without rewriting history.
 */
async function resolveRecipients(emails: string[]) {
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (wanted.length === 0) {
    throw new IncidentForwardError("Choose at least one recipient to forward to.");
  }

  const directory = await externalContacts();
  const byEmail = new Map(directory.map((c) => [c.email, c]));
  const unknown = wanted.filter((e) => !byEmail.has(e));
  if (unknown.length > 0) {
    throw new IncidentForwardError(
      `Not a configured external contact: ${unknown.join(", ")}. Add them in Settings first.`
    );
  }

  return wanted.map((e) => byEmail.get(e)!);
}

/**
 * Forwards a report to the chosen external contacts.
 *
 * Not best-effort, unlike the submission notifications this replaces: those fired
 * automatically after a commit that had to stand regardless, so swallowing their
 * failures was right. This one IS the user's action, so a failure must surface
 * rather than leave a reviewer believing a supervisor was told.
 */
export async function forwardReport(
  actorPersonId: string,
  reportId: string,
  input: ForwardInput
): Promise<void> {
  if (!(await can(actorPersonId, MANAGE))) {
    throw new IncidentForbiddenError("You do not have permission to forward incident reports.");
  }

  const report = await prisma.incidentReport.findUnique({ where: { id: reportId } });
  if (!report) throw new IncidentNotFoundError();

  const recipients = await resolveRecipients(input.emails);
  const note = (input.note ?? "").trim();
  const actor = await prisma.person.findUniqueOrThrow({
    where: { id: actorPersonId },
    select: { name: true },
  });
  const concernSummary = report.concernTypes.map((c) => CONCERN_LABELS[c] ?? c).join(", ");

  for (const contact of recipients) {
    const rendered = await renderEmail(
      "incidents.forwarded_external",
      forwardedExternalContext({
        recipientName: contact.name ?? "Colleague",
        subjectLine: `Incident report #${report.number}`,
        concernSummary,
        immediateRisk: report.immediateRisk,
        forwardedBy: actor.name,
        note,
      })
    );
    await queueEmail(prisma, {
      to: contact.email,
      subject: rendered.subject,
      html: rendered.html,
      template: "incidents.forwarded_external",
      // No personId: there is no Person behind this address.
      triggeredById: actorPersonId,
    });
    await prisma.incidentForward.create({
      data: {
        reportId: report.id,
        toEmail: contact.email,
        toName: contact.name,
        note: note || null,
        forwardedById: actorPersonId,
      },
    });
  }

  await recordAudit({
    action: "incident.forward",
    actorPersonId,
    entityType: "IncidentReport",
    entityId: report.id,
    after: { recipients: recipients.map((r) => r.email), note: note || null },
  });
}

/**
 * Forwards an issued strike to the chosen external contacts.
 *
 * REFUSES A CONFIDENTIAL STRIKE. decideStrike sets `confidential` from the
 * source report's `anonymous` flag, and a confidential strike is already
 * withheld from the subject's own directors in-app (strike-notifications.ts).
 * Sending one outside the clinic would widen the audience for an anonymous
 * report past every internal rule that protects the reporter, so this is a hard
 * refusal rather than a warning a reviewer can click through.
 */
export async function forwardStrike(
  actorPersonId: string,
  actionId: string,
  input: ForwardInput
): Promise<void> {
  if (!(await can(actorPersonId, MANAGE))) {
    throw new IncidentForbiddenError("You do not have permission to forward strikes.");
  }

  const action = await prisma.disciplinaryAction.findUnique({
    where: { id: actionId },
    include: { person: { select: { name: true } } },
  });
  if (!action) throw new IncidentNotFoundError();
  if (action.confidential) {
    throw new IncidentForwardError(
      "A confidential strike cannot be forwarded outside the clinic."
    );
  }

  const recipients = await resolveRecipients(input.emails);
  const note = (input.note ?? "").trim();
  const actor = await prisma.person.findUniqueOrThrow({
    where: { id: actorPersonId },
    select: { name: true },
  });

  for (const contact of recipients) {
    const rendered = await renderEmail(
      "incidents.forwarded_external",
      forwardedExternalContext({
        recipientName: contact.name ?? "Colleague",
        subjectLine: `A disciplinary action recorded for ${action.person.name}`,
        concernSummary: action.category,
        immediateRisk: false,
        forwardedBy: actor.name,
        note,
      })
    );
    await queueEmail(prisma, {
      to: contact.email,
      subject: rendered.subject,
      html: rendered.html,
      template: "incidents.forwarded_external",
      triggeredById: actorPersonId,
    });
    await prisma.incidentForward.create({
      data: {
        actionId: action.id,
        toEmail: contact.email,
        toName: contact.name,
        note: note || null,
        forwardedById: actorPersonId,
      },
    });
  }

  await recordAudit({
    action: "incident.forward",
    actorPersonId,
    entityType: "DisciplinaryAction",
    entityId: action.id,
    after: { recipients: recipients.map((r) => r.email), note: note || null },
  });
}

/** The disclosure trail for a report, newest first. */
export async function listReportForwards(reportId: string) {
  return prisma.incidentForward.findMany({
    where: { reportId },
    orderBy: { createdAt: "desc" },
    include: { forwardedBy: { select: { id: true, name: true } } },
  });
}

/** The disclosure trail for a set of strikes, keyed by action id. */
export async function forwardsByAction(actionIds: string[]) {
  const out = new Map<string, Awaited<ReturnType<typeof listReportForwards>>>();
  if (actionIds.length === 0) return out;
  const rows = await prisma.incidentForward.findMany({
    where: { actionId: { in: actionIds } },
    orderBy: { createdAt: "desc" },
    include: { forwardedBy: { select: { id: true, name: true } } },
  });
  for (const row of rows) {
    if (!row.actionId) continue;
    const list = out.get(row.actionId) ?? [];
    list.push(row);
    out.set(row.actionId, list);
  }
  return out;
}
