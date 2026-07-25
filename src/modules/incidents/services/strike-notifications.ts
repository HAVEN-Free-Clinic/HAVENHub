/**
 * Post-commit notification for an issued disciplinary strike.
 *
 * Both issue paths call this after their write commits: the Strikes ledger form
 * (gated on its "Notify by email" checkbox) and decideStrike (always). It cannot
 * live inside issueAction, which decideStrike calls with a transaction client --
 * queuing a notification inside that transaction would send mail for a strike
 * that might still roll back.
 *
 * Recipients:
 *   - The subject: incidents.strike_issued.
 *   - Directors of the subject's ACTIVE departments in the ACTIVE term:
 *     incidents.strike_issued_directors, resolved through the same
 *     departmentDirectorPersonIds helper compliance uses (so a one-hop
 *     DepartmentDelegation manager counts).
 *
 * A confidential strike notifies NO director. This mirrors directorVisibility()
 * in disciplinary.ts, where a director may only see a confidential row they
 * issued themselves; mailing them about a row they cannot open would leak it.
 * decideStrike sets confidential from report.anonymous, so anonymous-report
 * strikes are covered by the same rule.
 *
 * Best-effort throughout: every failure is logged and swallowed so it can never
 * throw out of, or roll back, a committed strike.
 */

import type { DisciplinaryAction } from "@prisma/client";
import { prisma } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { strikeIssuedDirectorsContext } from "@/platform/email/templates/incidents";
import { getSetting } from "@/platform/settings/service";
import { getActiveTerm } from "@/platform/terms/active-term";
import { departmentDirectorPersonIds } from "@/platform/departments";
import { formatCalendarDate } from "@/platform/dates";
import { visibleStrikeCount } from "./disciplinary";

export type StrikeNotificationInput = {
  /** The committed strike. */
  action: DisciplinaryAction;
  /** Who issued it. Excluded from the director set. */
  actorPersonId: string;
};

/** Recipient shape notify() needs. */
type Recipient = {
  id: string;
  name: string;
  entraObjectId: string | null;
  contactEmail: string | null;
};

/**
 * Directors to alert about a strike against `subjectPersonId`: the union of
 * departmentDirectorPersonIds across every department the subject is an ACTIVE
 * member of in the ACTIVE term, minus the subject and the issuing actor.
 * Returns [] when there is no active term or no membership.
 */
async function directorRecipients(
  subjectPersonId: string,
  actorPersonId: string
): Promise<Recipient[]> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return [];

  const memberships = await prisma.termMembership.findMany({
    where: { personId: subjectPersonId, termId: activeTerm.id, status: "ACTIVE" },
    select: { departmentId: true },
  });
  if (memberships.length === 0) return [];

  const departmentIds = [...new Set(memberships.map((m) => m.departmentId))];
  const idLists = await Promise.all(departmentIds.map((d) => departmentDirectorPersonIds(d)));

  const ids = [...new Set(idLists.flat())].filter(
    (id) => id !== subjectPersonId && id !== actorPersonId
  );
  if (ids.length === 0) return [];

  return prisma.person.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, entraObjectId: true, contactEmail: true },
  });
}

/**
 * Notifies the subject of a strike and, unless it is confidential, the directors
 * of their departments. Never throws.
 */
export async function notifyStrikeIssued(input: StrikeNotificationInput): Promise<void> {
  const { action, actorPersonId } = input;
  try {
    const [subject, issuer, baseUrl] = await Promise.all([
      prisma.person.findUnique({
        where: { id: action.personId },
        select: { id: true, name: true, entraObjectId: true, contactEmail: true },
      }),
      prisma.person.findUnique({ where: { id: actorPersonId }, select: { name: true } }),
      getSetting<string>("app.baseUrl"),
    ]);
    if (!subject) return;

    const issuedBy = issuer?.name ?? "HAVEN Directors";
    // A calendar-day marker (see occurredAt's doc comment): always UTC, never
    // zone-shifted, so it matches what the strikes ledger shows for the same row.
    const occurredDate = formatCalendarDate(action.occurredAt, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    // --- The subject ---
    // The subject-facing email must never carry the reporter's verbatim narrative
    // when the strike is confidential (decideStrike sets confidential from
    // report.anonymous): a first-person account ("I was working triage with him on
    // Saturday when he...") identifies the reporter to anyone who knows that shift's
    // roster, defeating the anonymity promise on the reporting form. Prefer the
    // reviewer's decision notes, which were authored as a record the subject may see,
    // and fall back to the raw description only for a non-confidential strike (#45).
    const subjectFacingDetails =
      action.notes?.trim() ||
      (action.confidential
        ? "Contact your department directors or the HAVEN Executive Directors for the details of this decision."
        : (action.description ?? ""));
    const subjectRendered = await renderEmail("incidents.strike_issued", {
      subjectName: subject.name?.trim().split(/\s+/)[0] || subject.name || "there",
      category: action.category,
      description: subjectFacingDetails,
      issuedBy,
      occurredDate,
    });
    await notify(prisma, {
      type: "incidents.strike_issued",
      person: subject,
      email: { subject: subjectRendered.subject, html: subjectRendered.html },
      teams: {
        title: "A disciplinary action has been recorded against you",
        summary: `A ${action.category} disciplinary action dated ${occurredDate} was recorded against you by ${issuedBy}.`,
      },
      triggeredById: actorPersonId,
    });

    // --- Their directors, unless the strike is confidential ---
    if (action.confidential) return;

    const directors = await directorRecipients(action.personId, actorPersonId);
    if (directors.length === 0) return;

    const ledgerLink = `${baseUrl}/incidents/strikes`;

    for (const director of directors) {
      // Scoped to what this director may see: mirrors directorVisibility, so a
      // confidential strike issued by someone else never inflates the count in
      // their notification (each director's visible total can differ).
      const total = await visibleStrikeCount(action.personId, director.id);
      const strikeLabel = `${total} strike${total === 1 ? "" : "s"}`;
      const rendered = await renderEmail(
        "incidents.strike_issued_directors",
        strikeIssuedDirectorsContext({
          directorName: director.name,
          subjectName: subject.name,
          category: action.category,
          occurredDate,
          issuedBy,
          strikeCount: strikeLabel,
          ledgerLink,
        })
      );
      await notify(prisma, {
        type: "incidents.strike_issued_directors",
        person: director,
        email: { subject: rendered.subject, html: rendered.html },
        teams: {
          title: `Disciplinary action recorded for ${subject.name}`,
          summary: `A ${action.category} disciplinary action dated ${occurredDate} was recorded against ${subject.name} by ${issuedBy}. They now have ${strikeLabel} on file.`,
          link: ledgerLink,
        },
        triggeredById: actorPersonId,
      });
    }
  } catch (err) {
    log.error(
      "[incidents] failed to notify of an issued strike",
      errorAttrs(err, { actionId: action.id, personId: action.personId })
    );
  }
}
