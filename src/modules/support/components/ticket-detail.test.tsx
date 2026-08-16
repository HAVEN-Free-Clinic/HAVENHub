/**
 * TicketDetail's read-only behavior for a ticket linked to Intercom
 * (intercomConversationId set), against the fully-interactive behavior of an
 * unlinked ticket. Follows memberships-card.test.tsx's approach: mock the
 * client-hook subcomponents (SubmitButton/ConfirmButton read useFormStatus,
 * EpicPersonPicker holds its own state) so the async server component can
 * render through renderToStaticMarkup, then assert on the resulting markup.
 *
 * TicketDetail is `async function` -- calling it directly (not via JSX)
 * resolves its one await (getDisplayTimeZone) before renderToStaticMarkup
 * ever sees the element, which is otherwise synchronous and needs no RSC
 * runtime.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TechRequestDetail } from "../services/tech-request";
import type { CommentRow } from "../services/comments";

vi.mock("@/platform/dates/resolve", () => ({
  getDisplayTimeZone: async () => "America/New_York",
}));

vi.mock("@/platform/ui/submit-button", () => ({
  SubmitButton: ({ children }: { children: ReactNode }) => <button type="submit">{children}</button>,
}));

vi.mock("@/platform/ui/confirm-button", () => ({
  ConfirmButton: ({ label }: { label: string }) => <button type="submit">{label}</button>,
}));

vi.mock("./epic-person-picker", () => ({
  EpicPersonPicker: () => <div data-testid="epic-person-picker" />,
}));

vi.mock("@/platform/intercom/messenger-actions", () => ({
  ContinueConversationButton: ({ conversationId }: { conversationId: string }) => (
    <button type="button" data-testid="continue-conversation" data-conversation-id={conversationId}>
      Continue in Messenger
    </button>
  ),
}));

const { TicketDetail } = await import("./ticket-detail");

const noop = async () => {};

function baseDetail(overrides: Partial<TechRequestDetail> = {}): TechRequestDetail {
  return {
    id: "req-1",
    number: 42,
    requesterId: "person-1",
    category: "GENERAL_IT",
    epicSubtype: null,
    subject: "Cannot reach the clinic wifi",
    description: "My laptop cannot join the clinic network.",
    priority: "MEDIUM",
    status: "IN_PROGRESS",
    assignedToId: null,
    resolution: null,
    resolvedAt: null,
    intercomConversationId: null,
    intercomTicketId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    requester: { id: "person-1", name: "Volunteer One", netId: "vol1", contactEmail: null, epicId: null },
    assignedTo: null,
    epicRequests: [],
    attachments: [],
    ...overrides,
  } as unknown as TechRequestDetail;
}

const comments: CommentRow[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("TicketDetail: unlinked ticket (no intercomConversationId)", () => {
  it("keeps every mutation control for a manager", async () => {
    const detail = baseDetail();
    const html = renderToStaticMarkup(
      await TicketDetail({
        detail,
        canManage: true,
        isRequester: false,
        managers: [],
        assignAction: noop,
        setStatusAction: noop,
        setPriorityAction: noop,
        resolveAction: noop,
        cancelAction: noop,
        comments,
        commentAction: noop,
        attachEpicAction: noop,
        cancelEpicAction: noop,
        departments: [],
      })
    );

    expect(html).toContain("Manager controls");
    expect(html).toContain("Update assignee");
    expect(html).toContain("Update status");
    expect(html).toContain("Update priority");
    expect(html).toContain("Resolve ticket");
    expect(html).toContain("Cancel ticket");
    expect(html).toContain("Close ticket");
    expect(html).toContain("Reply");
    expect(html).not.toContain("This ticket is managed in Intercom");
  });

  it("keeps the requester's own cancel button and the comment reply form", async () => {
    const detail = baseDetail();
    const html = renderToStaticMarkup(
      await TicketDetail({
        detail,
        canManage: false,
        isRequester: true,
        cancelOwnAction: noop,
        comments,
        commentAction: noop,
      })
    );

    expect(html).toContain("Cancel my request");
    expect(html).toContain("Reply");
  });
});

/**
 * Every fixture here carries intercomTicketId as well as intercomConversationId,
 * because that pair is what "Intercom manages this ticket" actually means: the
 * conversation holds the correspondence, and the TICKET id is what
 * applyIntercomTicketStateChange looks a row up by. These fixtures used to set
 * the conversation id alone and assert the manager panel was hidden, which
 * described a ticket no system could move at all -- see the unsynced-ticket
 * suite below (audit 14, SUP-2).
 */
describe("TicketDetail: synced ticket (both Intercom ids set)", () => {
  it("removes every manager mutation control and shows the Intercom banner instead", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
    const detail = baseDetail({ intercomConversationId: "conv-123", intercomTicketId: "ticket-123" });
    const html = renderToStaticMarkup(
      await TicketDetail({
        detail,
        canManage: true,
        isRequester: false,
        managers: [],
        assignAction: noop,
        setStatusAction: noop,
        setPriorityAction: noop,
        resolveAction: noop,
        cancelAction: noop,
        comments,
        commentAction: noop,
        attachEpicAction: noop,
        cancelEpicAction: noop,
        departments: [],
      })
    );

    expect(html).toContain("This ticket is managed in Intercom");
    expect(html).toContain("Open in Intercom");
    expect(html).toContain("https://app.intercom.com/a/inbox/unyx5lb2/inbox/conversation/conv-123");
    expect(html).not.toContain("Manager controls");
    expect(html).not.toContain("Update assignee");
    expect(html).not.toContain("Update priority");
    expect(html).not.toContain("Resolve ticket");
    expect(html).not.toContain("Cancel ticket");
    expect(html).not.toContain("Close ticket");
    // The banner's own copy starts with "Reply, reassign, ..." -- check for the
    // Reply *section heading* specifically, not the bare word.
    expect(html).not.toContain(">Reply<");
  });

  it("removes the requester's own cancel button and offers Continue in Messenger instead", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
    const detail = baseDetail({ intercomConversationId: "conv-123", intercomTicketId: "ticket-123" });
    const html = renderToStaticMarkup(
      await TicketDetail({
        detail,
        canManage: false,
        isRequester: true,
        cancelOwnAction: noop,
        comments,
        commentAction: noop,
      })
    );

    expect(html).not.toContain("Cancel my request");
    expect(html).toContain("continue-conversation");
    expect(html).toContain('data-conversation-id="conv-123"');
  });

  it("still shows the attached Epic chain read-only, without the attach form", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
    const detail = baseDetail({
      intercomConversationId: "conv-123",
      intercomTicketId: "ticket-123",
      epicRequests: [
        {
          id: "epic-1",
          kind: "NEW",
          status: "PENDING",
          person: { id: "person-1", name: "Volunteer One", epicId: null },
          ticket: null,
        },
      ],
    } as unknown as Partial<TechRequestDetail>);
    const html = renderToStaticMarkup(
      await TicketDetail({
        detail,
        canManage: true,
        isRequester: false,
        managers: [],
        assignAction: noop,
        setStatusAction: noop,
        setPriorityAction: noop,
        resolveAction: noop,
        cancelAction: noop,
        comments,
        commentAction: noop,
        attachEpicAction: noop,
        cancelEpicAction: noop,
        departments: [],
      })
    );

    expect(html).toContain("Epic access");
    expect(html).toContain("New account");
    expect(html).not.toContain("Attach Epic request(s)");
    expect(html).not.toContain(">Cancel<");
  });

  /**
   * The Epic to YNHH to ITCM workflow never moved to Intercom, and every EPIC
   * ticket now ARRIVES linked (created by the ticket.created webhook). So an
   * attach form gated on being unlinked is one nobody can ever reach, and no
   * EpicRequest could be raised at all. The page would still render fine --
   * it would just have no way forward -- which is why this is asserted rather
   * than left to the read-only rule's general shape.
   */
  it("keeps the Epic attach form on a linked EPIC ticket, since that workflow stays in the Hub", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
    const detail = baseDetail({ category: "EPIC", intercomConversationId: "conv-123", intercomTicketId: "ticket-123" });
    const html = renderToStaticMarkup(
      await TicketDetail({
        detail,
        canManage: true,
        isRequester: false,
        managers: [],
        assignAction: noop,
        setStatusAction: noop,
        setPriorityAction: noop,
        resolveAction: noop,
        cancelAction: noop,
        comments,
        commentAction: noop,
        attachEpicAction: noop,
        cancelEpicAction: noop,
        departments: [],
      })
    );

    expect(html).toContain("epic-person-picker");
  });

  /**
   * The linked-EPIC status-control exception is gone now that epic.ts drives
   * AWAITING_YNHH itself (epic-ticket-sync.ts) whenever an attached Epic
   * request is submitted to or resolved with YNHH -- see ticket-detail.tsx's
   * module doc comment. A linked EPIC ticket is read-only like any other
   * linked ticket: no Manager controls section at all.
   */
  it("shows no Manager controls section for a linked EPIC ticket, same as any other linked ticket", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
    const detail = baseDetail({ category: "EPIC", intercomConversationId: "conv-123", intercomTicketId: "ticket-123" });
    const html = renderToStaticMarkup(
      await TicketDetail({
        detail,
        canManage: true,
        isRequester: false,
        managers: [],
        assignAction: noop,
        setStatusAction: noop,
        setPriorityAction: noop,
        resolveAction: noop,
        cancelAction: noop,
        comments,
        commentAction: noop,
        attachEpicAction: noop,
        cancelEpicAction: noop,
        departments: [],
      })
    );

    expect(html).not.toContain("Manager controls");
    expect(html).not.toContain("Update status");
    expect(html).not.toContain("Update assignee");
    expect(html).not.toContain("Update priority");
    expect(html).not.toContain("Resolve ticket");
    expect(html).not.toContain("Cancel ticket");
    expect(html).not.toContain("Close ticket");
  });

  it("renders no deep link when the app id is unset, even though the ticket is linked", async () => {
    // NEXT_PUBLIC_INTERCOM_APP_ID intentionally left unset.
    const detail = baseDetail({ intercomConversationId: "conv-123", intercomTicketId: "ticket-123" });
    const html = renderToStaticMarkup(
      await TicketDetail({
        detail,
        canManage: true,
        isRequester: false,
        managers: [],
        assignAction: noop,
        setStatusAction: noop,
        setPriorityAction: noop,
        resolveAction: noop,
        cancelAction: noop,
        comments,
        commentAction: noop,
        attachEpicAction: noop,
        cancelEpicAction: noop,
        departments: [],
      })
    );

    expect(html).toContain("This ticket is managed in Intercom");
    expect(html).not.toContain("Open in Intercom");
    expect(html).not.toContain("app.intercom.com");
  });
});

/**
 * A ticket with a conversation but NO Intercom Ticket -- which is every ticket
 * Fin's custom action opens, since no Intercom Ticket exists at that moment.
 *
 * Hiding the manager panel on the conversation id made this ticket unmanageable
 * from BOTH sides at once: Intercom cannot drive its status (every inbound path
 * keys on intercomTicketId, which is null here) and the Hub would not offer a
 * control either, so it sat at whatever status it was created with,
 * permanently, while the page rendered as though everything were fine (audit
 * 14, SUP-2).
 */
describe("TicketDetail: linked but unsynced ticket (conversation id, no Intercom ticket id)", () => {
  it("keeps the manager control panel, because nothing else can move this ticket's status", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
    const detail = baseDetail({ intercomConversationId: "conv-123", intercomTicketId: null });
    const html = renderToStaticMarkup(
      await TicketDetail({
        detail,
        canManage: true,
        isRequester: false,
        managers: [],
        assignAction: noop,
        setStatusAction: noop,
        setPriorityAction: noop,
        resolveAction: noop,
        cancelAction: noop,
        comments,
        commentAction: noop,
        attachEpicAction: noop,
        cancelEpicAction: noop,
        departments: [],
      })
    );

    expect(html).toContain("Manager controls");
    expect(html).toContain("Update status");
    expect(html).toContain("Update assignee");
    expect(html).toContain("Update priority");
    expect(html).toContain("Resolve ticket");
  });

  // The banner has to agree with the page. Telling a manager to change the
  // status in Intercom, while the Hub renders the status control right below
  // it, sends them looking for a control that does not exist on a ticket
  // Intercom has no state object for.
  it("says the conversation is in Intercom, not that the ticket is managed there", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
    const detail = baseDetail({ intercomConversationId: "conv-123", intercomTicketId: null });
    const html = renderToStaticMarkup(
      await TicketDetail({
        detail,
        canManage: true,
        isRequester: false,
        managers: [],
        assignAction: noop,
        setStatusAction: noop,
        setPriorityAction: noop,
        resolveAction: noop,
        cancelAction: noop,
        comments,
        commentAction: noop,
      })
    );

    expect(html).toContain("This conversation is in Intercom");
    expect(html).not.toContain("This ticket is managed in Intercom");
    expect(html).toContain("Open in Intercom");
  });

  // The correspondence really does live in Intercom for this ticket, so the
  // reply form and the requester's own cancel stay hidden. Only the status
  // control surface changes, which is the whole of what was broken.
  it("still routes correspondence to Intercom, keeping the reply form and owner cancel hidden", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
    const detail = baseDetail({ intercomConversationId: "conv-123", intercomTicketId: null });
    const html = renderToStaticMarkup(
      await TicketDetail({
        detail,
        canManage: false,
        isRequester: true,
        cancelOwnAction: noop,
        comments,
        commentAction: noop,
      })
    );

    expect(html).not.toContain("Cancel my request");
    expect(html).not.toContain(">Reply<");
    expect(html).toContain("continue-conversation");
  });
});
