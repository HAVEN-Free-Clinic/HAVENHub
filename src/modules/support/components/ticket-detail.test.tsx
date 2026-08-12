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

describe("TicketDetail: linked ticket (intercomConversationId set)", () => {
  it("removes every manager mutation control and shows the Intercom banner instead", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
    const detail = baseDetail({ intercomConversationId: "conv-123" });
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
    const detail = baseDetail({ intercomConversationId: "conv-123" });
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
    const detail = baseDetail({ category: "EPIC", intercomConversationId: "conv-123" });
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

  it("keeps only the status control for a linked EPIC ticket", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
    const detail = baseDetail({ category: "EPIC", intercomConversationId: "conv-123" });
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
    expect(html).not.toContain("Update assignee");
    expect(html).not.toContain("Update priority");
    expect(html).not.toContain("Resolve ticket");
    expect(html).not.toContain("Cancel ticket");
    expect(html).not.toContain("Close ticket");
  });

  it("renders no deep link when the app id is unset, even though the ticket is linked", async () => {
    // NEXT_PUBLIC_INTERCOM_APP_ID intentionally left unset.
    const detail = baseDetail({ intercomConversationId: "conv-123" });
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
