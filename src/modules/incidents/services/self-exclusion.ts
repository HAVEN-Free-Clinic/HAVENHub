/**
 * The incidents module's self-exclusion rule, in one place.
 *
 * **A person linked as the subject of a report may never act on, or read, that
 * report -- even holding `incidents.manage`.** The reason is anonymity: a
 * narrative like "I was on triage with her Saturday morning when..." identifies
 * the reporter to anyone who knows that shift's roster, so a subject who can
 * reach the record can unmask a reporter the form promised to protect (#45).
 *
 * The rule was enforced in `report.ts` (getReport, listReviewQueue, reviewReport,
 * decideStrike) and in the attachment route, but each site re-derived it inline
 * and four sibling paths were missed entirely: forwardReport, forwardStrike,
 * deleteAction, and linkActionToReport (audit 14). Those are the paths that let a
 * subject email their own report outside the clinic, or delete the strike issued
 * against them. Factored out here so a new path has one obvious thing to call
 * rather than a pattern to notice.
 *
 * Deliberately a leaf module: `report.ts` imports `disciplinary.ts`, so neither
 * can host this without a cycle. It returns booleans rather than throwing, so
 * each caller raises its own module's error type.
 */

import { prisma } from "@/platform/db";

/** True when `actorPersonId` is a linked subject of `reportId`. */
export async function isReportSubject(
  actorPersonId: string,
  reportId: string
): Promise<boolean> {
  const row = await prisma.incidentReportSubject.findFirst({
    where: { reportId, personId: actorPersonId },
    select: { id: true },
  });
  return row !== null;
}

/**
 * True when `actorPersonId` may not act on this strike: either it is a strike
 * against them, or it came from a report they are a subject of (which covers the
 * co-subject case the same way decideStrike does).
 */
export async function isStrikeSubject(
  actorPersonId: string,
  action: { personId: string; reportId: string | null }
): Promise<boolean> {
  if (action.personId === actorPersonId) return true;
  if (!action.reportId) return false;
  return isReportSubject(actorPersonId, action.reportId);
}
