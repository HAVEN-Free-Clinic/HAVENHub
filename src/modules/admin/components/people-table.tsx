/**
 * PeopleTable: server component rendering a table of Person rows.
 *
 * For the list view we display: Name (link to detail), NetID, Email,
 * Status badge, and a membership count for the active term (a simple
 * count is cheaper than full department lookups on 660+ rows).
 */

import Link from "next/link";
import type { Person } from "@prisma/client";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";

type Row = Person & { _membershipCount?: number };

export function PeopleTable({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return (
      <Card pad={false} className="px-6 py-10 text-center text-sm text-slate-500">
        No people found.
      </Card>
    );
  }

  return (
    <Table>
      <THead>
        <TR>
          <TH>Name</TH>
          <TH>NetID</TH>
          <TH>Email</TH>
          <TH>Memberships</TH>
          <TH>Flags</TH>
          <TH>Status</TH>
        </TR>
      </THead>
      <tbody>
        {rows.map((person) => (
          <TR key={person.id}>
            <TD>
              <Link
                href={`/admin/people/${person.id}`}
                className="font-medium text-brand hover:underline"
              >
                {person.name}
              </Link>
            </TD>
            <TD className="text-slate-500">
              {person.netId ?? <span className="text-slate-300">-</span>}
            </TD>
            <TD className="text-slate-500">
              {person.contactEmail ?? <span className="text-slate-300">-</span>}
            </TD>
            <TD className="text-slate-500 tabular-nums">
              {person._membershipCount ?? 0}
            </TD>
            <TD>
              <span className="flex flex-wrap gap-1">
                {person.spanishSpeaking && <Badge tone="default">ES</Badge>}
                {person.licensedRN && <Badge tone="default">RN</Badge>}
              </span>
            </TD>
            <TD>
              {person.status === "ACTIVE" ? (
                <Badge tone="success">Active</Badge>
              ) : (
                <Badge tone="default">Offboarded</Badge>
              )}
            </TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}
