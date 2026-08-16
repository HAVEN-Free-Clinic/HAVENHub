/**
 * Who may see one incident report, and with what powers.
 *
 * A leaf module (no imports) so both report.ts and messages.ts can depend on it
 * without a cycle. It exists because this rule is now enforced in more than one
 * place: getReport gates the detail page, and the clarification thread gates
 * reads and writes of messages. Two hand-written copies of a rule this
 * consequential WILL drift -- one gets a fix the other doesn't -- so there is
 * exactly one copy and both callers pass through it.
 *
 * Deliberately pure and DB-free: it takes the report's reporter/subjects and the
 * already-resolved `incidents.manage` answer, and returns a decision. That makes
 * every branch reachable from a unit test without seeding RBAC.
 */

/** The actor's standing on a report they are allowed to see at all. */
export type ReportAccess = {
  /** The actor filed this report. */
  isOwner: boolean;
  /**
   * The actor may exercise reviewer powers here: holds incidents.manage AND is
   * not a linked subject. Every reviewer-only surface (reviewNotes, the status
   * control, strike decisions, asking the reporter a question) keys off this,
   * never off the bare permission.
   */
  effectiveManage: boolean;
};

/**
 * Resolves what `actorPersonId` may do with `report`, or null if they may not
 * see it at all (callers throw IncidentForbiddenError).
 *
 * Two separate exclusions, both load-bearing:
 *
 *  - Not the reporter and no incidents.manage -> nothing. A report is visible to
 *    the person who filed it and to reviewers, and to nobody else.
 *  - A linked SUBJECT of the report never reaches it through incidents.manage.
 *    They could otherwise unmask an anonymous reporter, read reviewNotes about
 *    themselves, or self-adjudicate a strike. Reaching this check with !isOwner
 *    implies canManage, so it only ever closes the manage path.
 *
 * The owner path survives that second exclusion (someone may file a report that
 * also names them), but a subject still loses `effectiveManage`: reviewReport
 * and decideStrike both reject a subject server-side, so granting it would leak
 * reviewNotes and render controls that can only fail.
 */
export function resolveReportAccess(
  report: { reporterId: string; subjects: Array<{ personId: string }> },
  actorPersonId: string,
  canManage: boolean
): ReportAccess | null {
  const isOwner = report.reporterId === actorPersonId;
  if (!canManage && !isOwner) return null;

  const actorIsSubject = report.subjects.some((s) => s.personId === actorPersonId);
  if (!isOwner && actorIsSubject) return null;

  return { isOwner, effectiveManage: canManage && !actorIsSubject };
}
