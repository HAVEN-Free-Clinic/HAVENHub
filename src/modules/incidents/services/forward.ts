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
 * RECIPIENTS ARE TYPED, NOT PICKED FROM A LIST. These advisors are third
 * parties: no Hub account, no Person record, nothing to pre-register them
 * against. An earlier version of this required every address to exist in a
 * settings directory first, which put an admin step between a reviewer and the
 * advisor they needed to reach, for no safety the trail below does not already
 * provide. Addresses used before are offered as suggestions instead.
 *
 * What DOES hold: every forward is recorded on the record it disclosed
 * (IncidentForward), not just in EmailLog. A reviewer deciding whether to
 * forward needs to see who already received it, and an audit of a disclosure
 * that left the organization needs the trail attached to the record itself.
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

/** A forward that cannot be sent as asked: no recipients, or a malformed address. */
export class IncidentForwardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncidentForwardError";
  }
}

export type ForwardInput = {
  /** Addresses the reviewer typed. */
  emails: string[];
  /** Optional covering note from the reviewer, included in the email. */
  note?: string;
};

const MANAGE = "incidents.manage";

/** Deliberately permissive: enough to catch a typo that is not an address at
 *  all, without pretending to validate deliverability. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function resolveRecipients(emails: string[]): string[] {
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (wanted.length === 0) {
    throw new IncidentForwardError("Enter at least one address to forward to.");
  }

  const malformed = wanted.filter((e) => !EMAIL.test(e));
  if (malformed.length > 0) {
    throw new IncidentForwardError(`Not a valid email address: ${malformed.join(", ")}`);
  }

  return wanted;
}

/**
 * Addresses forwarded to before, most recent first.
 *
 * Offered as SUGGESTIONS on the forward form, never as a constraint: typing a
 * medical advisor's address from memory each time invites the one typo that
 * sends an incident report to a stranger. Derived from the forward trail, so it
 * needs no separate contact list to keep in sync.
 */
export async function recentForwardEmails(limit = 20): Promise<string[]> {
  const rows = await prisma.incidentForward.findMany({
    orderBy: { createdAt: "desc" },
    select: { toEmail: true },
    take: 200,
  });
  const seen: string[] = [];
  for (const r of rows) {
    if (!seen.includes(r.toEmail)) seen.push(r.toEmail);
    if (seen.length >= limit) break;
  }
  return seen;
}

/**
 * Forwards a report to the addresses the reviewer entered.
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

  const recipients = resolveRecipients(input.emails);
  const note = (input.note ?? "").trim();
  const actor = await prisma.person.findUniqueOrThrow({
    where: { id: actorPersonId },
    select: { name: true },
  });
  const concernSummary = report.concernTypes.map((c) => CONCERN_LABELS[c] ?? c).join(", ");

  for (const email of recipients) {
    const rendered = await renderEmail(
      "incidents.forwarded_external",
      forwardedExternalContext({
        recipientName: "Colleague",
        subjectLine: `Incident report #${report.number}`,
        concernSummary,
        immediateRisk: report.immediateRisk,
        forwardedBy: actor.name,
        note,
      })
    );
    await queueEmail(prisma, {
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      template: "incidents.forwarded_external",
      // No personId: there is no Person behind this address.
      triggeredById: actorPersonId,
    });
    await prisma.incidentForward.create({
      data: {
        reportId: report.id,
        toEmail: email,
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
    after: { recipients, note: note || null },
  });
}

/**
 * Forwards an issued strike to the addresses the reviewer entered.
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

  const recipients = resolveRecipients(input.emails);
  const note = (input.note ?? "").trim();
  const actor = await prisma.person.findUniqueOrThrow({
    where: { id: actorPersonId },
    select: { name: true },
  });

  for (const email of recipients) {
    const rendered = await renderEmail(
      "incidents.forwarded_external",
      forwardedExternalContext({
        recipientName: "Colleague",
        subjectLine: `A disciplinary action recorded for ${action.person.name}`,
        concernSummary: action.category,
        immediateRisk: false,
        forwardedBy: actor.name,
        note,
      })
    );
    await queueEmail(prisma, {
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      template: "incidents.forwarded_external",
      triggeredById: actorPersonId,
    });
    await prisma.incidentForward.create({
      data: {
        actionId: action.id,
        toEmail: email,
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
    after: { recipients, note: note || null },
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
