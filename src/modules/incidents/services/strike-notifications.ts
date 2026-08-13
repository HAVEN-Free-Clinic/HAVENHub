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
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { formatCalendarDate } from "@/platform/dates";
import { visibleStrikeCount, subjectFacingDetail } from "./disciplinary";

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
 * Senior staff copied on an issued strike for visibility
 * (incidents.escalation_recipient), minus the subject and the issuing actor,
 * and minus anyone already in `existing` so nobody is mailed twice.
 *
 * They hold no incidents.view_strikes, so their email carries no ledger link.
 * The caller supplies that distinction; this only resolves who they are.
 */
async function escalationRecipients(
  subjectPersonId: string,
  actorPersonId: string,
  existing: Recipient[]
): Promise<Recipient[]> {
  const holders = await peopleWithAnyPermission(["incidents.escalation_recipient"]);
  const already = new Set([...existing.map((r) => r.id), subjectPersonId, actorPersonId]);
  return holders
    .filter((h) => !already.has(h.id))
    .map((h) => ({
      id: h.id,
      name: h.name,
      entraObjectId: h.entraObjectId,
      contactEmail: h.contactEmail,
    }));
}

/**
 * Notifies the subject of a strike and, unless it is confidential, the directors
 * of their departments. Never throws.
 */
export async function notifyStrikeIssued(input: StrikeNotificationInput): Promise<void> {
  const { action, actorPersonId } = input;
  try {
    const [subject, issuer, baseUrl, strikeThreshold] = await Promise.all([
      prisma.person.findUnique({
        where: { id: action.personId },
        select: { id: true, name: true, entraObjectId: true, contactEmail: true },
      }),
      prisma.person.findUnique({ where: { id: actorPersonId }, select: { name: true } }),
      getSetting<string>("app.baseUrl"),
      getSetting<number>("incidents.strikeThreshold"),
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
    // Redaction lives in subjectFacingDetail (disciplinary.ts), shared with the
    // member's own strike list on /my-info so the two surfaces that show a
    // person their own strike cannot drift apart. See that function for why a
    // confidential strike must not carry the reporter's narrative (#45).
    const subjectFacingDetails = subjectFacingDetail(action);
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

    // --- Their directors and escalation recipients, unless confidential ---
    //
    // A confidential strike notifies NEITHER group. For directors that mirrors
    // directorVisibility, which only lets them open a confidential row they
    // issued themselves. For escalation recipients the rule is stricter still:
    // they hold no incidents.view_strikes at all, so a confidential strike must
    // never reach them. decideStrike sets confidential from report.anonymous, so
    // this is what keeps an anonymous reporter's report from being announced to
    // a wider audience than the reviewers who handled it.
    if (action.confidential) return;

    const directors = await directorRecipients(action.personId, actorPersonId);
    const escalation = await escalationRecipients(action.personId, actorPersonId, directors);
    if (directors.length === 0 && escalation.length === 0) return;

    const ledgerLink = `${baseUrl}/incidents/strikes`;

    // Directors get the ledger link; escalation recipients cannot open the
    // ledger, so theirs is omitted (the template guards on a non-empty value).
    const recipients = [
      ...directors.map((r) => ({ person: r, canOpenLedger: true })),
      ...escalation.map((r) => ({ person: r, canOpenLedger: false })),
    ];

    for (const { person: director, canOpenLedger } of recipients) {
      // Scoped to what this director may see: mirrors directorVisibility, so a
      // confidential strike issued by someone else never inflates the count in
      // their notification (each director's visible total can differ).
      const total = await visibleStrikeCount(action.personId, director.id);
      // Say plainly when the policy limit is reached rather than leaving each
      // director to remember the number and compare. Appended to the existing
      // count phrase so the template needs no new variable and any admin
      // override of that template keeps working.
      //
      // Deliberately informational: reaching the limit triggers nothing
      // automatic. Whether the member is offboarded stays an ED decision, and an
      // automatic membership change driven by a count would be both a policy
      // call the code should not make and hard to reverse.
      const atLimit = strikeThreshold > 0 && total >= strikeThreshold;
      const strikeLabel =
        `${total} strike${total === 1 ? "" : "s"}` +
        (atLimit ? ` (at or over the ${strikeThreshold}-strike limit)` : "");
      const rendered = await renderEmail(
        "incidents.strike_issued_directors",
        strikeIssuedDirectorsContext({
          directorName: director.name,
          subjectName: subject.name,
          category: action.category,
          occurredDate,
          issuedBy,
          strikeCount: strikeLabel,
          ledgerLink: canOpenLedger ? ledgerLink : "",
        })
      );
      await notify(prisma, {
        type: "incidents.strike_issued_directors",
        person: director,
        email: { subject: rendered.subject, html: rendered.html },
        teams: {
          title: `Disciplinary action recorded for ${subject.name}`,
          summary: `A ${action.category} disciplinary action dated ${occurredDate} was recorded against ${subject.name} by ${issuedBy}. They now have ${strikeLabel} on file.`,
          link: canOpenLedger ? ledgerLink : null,
        },
        triggeredById: actorPersonId,
      });
    }

    // --- External clinical supervisors: deliberately NOT notified here ---
    //
    // Issuing a strike used to blind-copy every address in
    // incidents.externalEscalationEmails. A reviewer now forwards a strike to
    // chosen supervisors from the strikes ledger (forward.ts), and that
    // disclosure is recorded against the strike.
    //
    // Worth knowing if you are tempted to restore an automatic send here: the
    // old one was never as reliable as it looked. The "nobody internal to
    // notify" early return above sits ABOVE this point, so a subject with no
    // department directors and no escalation recipients never reached the
    // external send at all.
  } catch (err) {
    log.error(
      "[incidents] failed to notify of an issued strike",
      errorAttrs(err, { actionId: action.id, personId: action.personId })
    );
  }
}
