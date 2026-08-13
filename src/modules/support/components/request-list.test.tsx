/**
 * RequestList's Intercom affordance: a linked row gets the matching action
 * for its audience (messenger widget for the member's own list, an inbox
 * deep link for the manager list); an unlinked row or a caller with no
 * intercomAction gets neither. Also the "member list renders from Hub rows,
 * with no Intercom API call" requirement -- nothing here reaches the network,
 * so a passing render already proves that.
 *
 * RequestList is a synchronous Server Component; DateOnly (rendered per row)
 * is itself an async Server Component that reads the display time zone from
 * settings (a DB read), so it is mocked here the same way ticket-detail.test.tsx
 * mocks its client-hook subcomponents -- this test is about the Intercom
 * column, not date formatting.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TechRequestListRow } from "../services/tech-request";

vi.mock("@/platform/dates/display", () => ({
  DateOnly: ({ value }: { value: Date }) => <span>{value.toISOString()}</span>,
}));

const { RequestList } = await import("./request-list");

function row(overrides: Partial<TechRequestListRow> = {}): TechRequestListRow {
  return {
    id: "req-1",
    number: 7,
    category: "GENERAL_IT",
    epicSubtype: null,
    subject: "Cannot reach the clinic wifi",
    priority: "MEDIUM",
    status: "IN_PROGRESS",
    assignedToId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    intercomConversationId: null,
    requester: { id: "person-1", name: "Volunteer One" },
    assignedTo: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("RequestList", () => {
  it("renders straight from the passed-in rows -- no Intercom API call, no intercomAction column by default", () => {
    const html = renderToStaticMarkup(
      <RequestList rows={[row()]} hrefBase="/support" showRequester={false} />
    );
    expect(html).toContain("Cannot reach the clinic wifi");
    expect(html).not.toContain("Conversation");
    expect(html).not.toContain("Continue in Messenger");
    expect(html).not.toContain("Open in Intercom");
  });

  it('intercomAction="messenger": a linked row offers Continue in Messenger', () => {
    const html = renderToStaticMarkup(
      <RequestList
        rows={[row({ intercomConversationId: "conv-1" })]}
        hrefBase="/support"
        intercomAction="messenger"
      />
    );
    expect(html).toContain("Conversation");
    expect(html).toContain("Continue in Messenger");
    expect(html).not.toContain("Open in Intercom");
  });

  it('intercomAction="messenger": an unlinked row shows a dash, not a button', () => {
    const html = renderToStaticMarkup(
      <RequestList rows={[row({ intercomConversationId: null })]} hrefBase="/support" intercomAction="messenger" />
    );
    expect(html).not.toContain("Continue in Messenger");
  });

  it('intercomAction="inbox": a linked row deep-links into Intercom once the app id is set', () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    const html = renderToStaticMarkup(
      <RequestList
        rows={[row({ intercomConversationId: "conv-1" })]}
        hrefBase="/support"
        showRequester
        intercomAction="inbox"
      />
    );
    expect(html).toContain("Open in Intercom");
    expect(html).toContain("https://app.intercom.com/a/inbox/unyx5lb2/inbox/conversation/conv-1");
    expect(html).not.toContain("Continue in Messenger");
  });

  it('intercomAction="inbox": no deep link when the app id is unset, even for a linked row', () => {
    // NEXT_PUBLIC_INTERCOM_APP_ID intentionally left unset.
    const html = renderToStaticMarkup(
      <RequestList
        rows={[row({ intercomConversationId: "conv-1" })]}
        hrefBase="/support"
        showRequester
        intercomAction="inbox"
      />
    );
    expect(html).not.toContain("Open in Intercom");
    expect(html).not.toContain("app.intercom.com");
  });

  it("shows the empty state when there are no rows", () => {
    const html = renderToStaticMarkup(<RequestList rows={[]} hrefBase="/support" />);
    expect(html).toContain("No requests yet.");
  });
});
