/**
 * Shared body of the calendar-feed server actions.
 *
 * Takes an ALREADY-AUTHORIZED personId. Authorization stays in the pages
 * because My Info and My Schedule gate on different module permissions, and a
 * member who can reach either page must be able to manage their own feed from
 * it. Centralizing the gate here would let one page render the card and then
 * fail on click.
 */

import { recordAudit } from "@/platform/audit";
import { issueFeedToken } from "./feed-token";

/** Issue or rotate this person's feed token and record the audit entry. */
export async function issueAuditedFeedToken(personId: string, kind: "issue" | "reset"): Promise<void> {
  await issueFeedToken(personId);
  await recordAudit({
    actorPersonId: personId,
    action: `calendar_feed.${kind}`,
    entityType: "CalendarFeedToken",
    // The token itself never reaches the audit log; the person is the subject.
    entityId: personId,
  });
}
