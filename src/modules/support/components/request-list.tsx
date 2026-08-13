/**
 * RequestList: table of TechRequest rows shared by the owner "My requests"
 * view (Task 5) and the manager master list (later task). `showRequester`
 * adds a Requester column for the manager view, where rows span everyone's
 * tickets; the owner view omits it since every row already belongs to them.
 * Rows link to `${hrefBase}/${id}`, the single detail route both views share.
 *
 * Follows the PeopleTable / departments-list convention: a Card empty state,
 * otherwise the Table/THead/TR/TH/TD primitives with the primary cell as a
 * Link.
 *
 * `intercomAction` adds a Conversation column for a linked row's matching
 * Intercom affordance. Two different actions because the two callers are two
 * different audiences: a member has no login to Intercom's own inbox, so
 * "My requests" opens the Messenger widget; a manager works tickets in that
 * inbox, so "All requests" deep-links there instead. Rows read straight off
 * Prisma (TechRequestListRow.intercomConversationId, synced in by the webhook
 * already) -- there is no Intercom API call anywhere in this component.
 */

import Link from "next/link";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { DateOnly } from "@/platform/dates/display";
import { intercomConversationUrl } from "@/platform/intercom/config";
import { ContinueConversationButton } from "@/platform/intercom/messenger-actions";
import { ExternalLinkButton } from "@/platform/ui/external-link-button";
import { SupportStatusBadge } from "./status-badge";
import { CATEGORY_LABELS } from "@/modules/support/labels";
import type { TechRequestListRow } from "../services/tech-request";

type RequestListProps = {
  rows: TechRequestListRow[];
  hrefBase: string;
  showRequester?: boolean;
  /**
   * Adds the Conversation column. Omit entirely (leave undefined) when
   * Intercom is not configured -- callers gate this on isIntercomConfigured()
   * -- so no dead column renders for CI, e2e, preview, or demo, none of which
   * set the app id.
   */
  intercomAction?: "messenger" | "inbox";
};

function ConversationCell({
  row,
  intercomAction,
}: {
  row: TechRequestListRow;
  intercomAction: "messenger" | "inbox";
}) {
  if (!row.intercomConversationId) {
    return <span className="text-subtle-foreground">-</span>;
  }
  if (intercomAction === "messenger") {
    return (
      <ContinueConversationButton conversationId={row.intercomConversationId} variant="outline" size="sm">
        Continue in Messenger
      </ContinueConversationButton>
    );
  }
  // "inbox": a deep link into Intercom's agent inbox, not the Messenger --
  // intercomConversationUrl returns null when the app id is unset, and a row
  // reaching this branch already implies intercomAction was gated on
  // isIntercomConfigured() by the caller, but re-checking here means one
  // stale env var can never produce a broken link.
  const url = intercomConversationUrl(row.intercomConversationId);
  if (!url) {
    return <span className="text-subtle-foreground">-</span>;
  }
  return (
    <ExternalLinkButton href={url} variant="ghost" size="sm">
      Open in Intercom
    </ExternalLinkButton>
  );
}

export function RequestList({ rows, hrefBase, showRequester = false, intercomAction }: RequestListProps) {
  if (rows.length === 0) {
    return (
      <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
        No requests yet.
      </Card>
    );
  }

  return (
    <Table>
      <THead>
        <TR>
          <TH>#</TH>
          <TH>Subject</TH>
          <TH>Category</TH>
          {showRequester && <TH>Requester</TH>}
          <TH>Status</TH>
          <TH>Updated</TH>
          {intercomAction && <TH>Conversation</TH>}
        </TR>
      </THead>
      <tbody>
        {rows.map((row) => (
          <TR key={row.id}>
            <TD className="text-muted-foreground tabular-nums">{row.number}</TD>
            <TD>
              <Link
                href={`${hrefBase}/${row.id}`}
                className="font-medium text-brand-fg hover:underline"
              >
                {row.subject}
              </Link>
            </TD>
            <TD className="text-muted-foreground">{CATEGORY_LABELS[row.category]}</TD>
            {showRequester && (
              <TD className="text-muted-foreground">
                {row.requester.name ?? <span className="text-subtle-foreground">-</span>}
              </TD>
            )}
            <TD>
              <SupportStatusBadge status={row.status} />
            </TD>
            <TD className="text-muted-foreground"><DateOnly value={row.updatedAt} /></TD>
            {intercomAction && (
              <TD>
                <ConversationCell row={row} intercomAction={intercomAction} />
              </TD>
            )}
          </TR>
        ))}
      </tbody>
    </Table>
  );
}
