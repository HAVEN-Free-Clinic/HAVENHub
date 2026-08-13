/**
 * What a viewer may see on a ticket detail page.
 *
 * Three viewers reach that page, and they are not a hierarchy: a manager works
 * the ticket, the requester owns it, and a support.view_all_requests auditor
 * merely tracks it. The auditor is the reason this exists. Before that
 * permission, "not a manager" implied "the requester", so the page could show
 * the comment thread and attachments to any non-manager who got past
 * getTechRequest. That inference is now false, and correspondence -- replies,
 * internal notes' existence, uploaded files -- is deliberately outside the
 * read-only grant.
 *
 * Kept as a pure function rather than inlined in the page so the rule is
 * testable and stated once: the page decides which data to load from it, and
 * TicketDetail decides what to render from it, without either restating it.
 */

export type TicketViewer = {
  /** Holds support.manage_requests. */
  canManage: boolean;
  /** Filed this ticket. */
  isRequester: boolean;
};

export type TicketViewCapabilities = {
  /** Assign / status / priority / resolve / cancel / Epic controls. */
  showManagerControls: boolean;
  /** The comment thread, the reply form, and the attachment list. */
  showCorrespondence: boolean;
};

export function ticketViewCapabilities(viewer: TicketViewer): TicketViewCapabilities {
  return {
    showManagerControls: viewer.canManage,
    showCorrespondence: viewer.canManage || viewer.isRequester,
  };
}
