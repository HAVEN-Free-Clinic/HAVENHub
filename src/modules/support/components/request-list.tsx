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
 */

import Link from "next/link";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { DateOnly } from "@/platform/dates/display";
import { SupportStatusBadge } from "./status-badge";
import { CATEGORY_LABELS } from "@/modules/support/labels";
import type { TechRequestListRow } from "../services/tech-request";

type RequestListProps = {
  rows: TechRequestListRow[];
  hrefBase: string;
  showRequester?: boolean;
};

export function RequestList({ rows, hrefBase, showRequester = false }: RequestListProps) {
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
          </TR>
        ))}
      </tbody>
    </Table>
  );
}
