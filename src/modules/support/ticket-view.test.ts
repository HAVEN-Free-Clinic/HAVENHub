/**
 * The ticket detail page serves three viewers at different strengths, and the
 * one that is easy to get wrong is the newest: a support.view_all_requests
 * auditor, who may see that a ticket exists and where it stands but not its
 * correspondence. Before this permission existed the page only had to ask
 * "manager or requester?", and everything a non-manager saw was safe to show
 * because the only non-manager who got this far owned the ticket.
 */

import { describe, expect, it } from "vitest";
import { ticketViewCapabilities } from "./ticket-view";

describe("ticketViewCapabilities", () => {
  it("gives a manager the controls and the correspondence", () => {
    expect(ticketViewCapabilities({ canManage: true, isRequester: false })).toEqual({
      showManagerControls: true,
      showCorrespondence: true,
    });
  });

  it("gives the requester their own correspondence but no controls", () => {
    expect(ticketViewCapabilities({ canManage: false, isRequester: true })).toEqual({
      showManagerControls: false,
      showCorrespondence: true,
    });
  });

  it("gives a view-only auditor neither", () => {
    // The auditor reaches the page through getTechRequest, which admits them,
    // so nothing upstream stops the comment thread and attachment list from
    // rendering. This is the only thing that does.
    expect(ticketViewCapabilities({ canManage: false, isRequester: false })).toEqual({
      showManagerControls: false,
      showCorrespondence: false,
    });
  });

  it("keeps the correspondence for a manager who also filed the ticket", () => {
    expect(ticketViewCapabilities({ canManage: true, isRequester: true })).toEqual({
      showManagerControls: true,
      showCorrespondence: true,
    });
  });
});
