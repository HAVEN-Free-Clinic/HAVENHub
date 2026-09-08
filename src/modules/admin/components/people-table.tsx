/**
 * PeopleTable: server component rendering a table of Person rows.
 *
 * For the list view we display: Photo, Name (link to detail), NetID, Email,
 * Status badge, and a membership count for the active term (a simple
 * count is cheaper than full department lookups on 660+ rows).
 */

import type { Person } from "@prisma/client";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { TextLink } from "@/platform/ui/text-link";
import { PersonPhoto } from "@/platform/ui/person-photo";
import { ListEmpty } from "@/platform/ui/list-empty";
import { CapabilityBadges } from "@/platform/ui/capability-badges";

/** Verified language codes, resolved by the page (see verifiedLanguagesByPerson). */
type Row = Person & { _membershipCount?: number; verifiedLanguages: string[] };

export function PeopleTable({
  rows,
  filtered = false,
}: {
  rows: Row[];
  /** Whether the page applied a search or filter. See ListEmpty. */
  filtered?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <Card pad={false}>
        <ListEmpty filtered={filtered} noun="people" />
      </Card>
    );
  }

  return (
    <Table>
      <THead>
        <TR>
          <TH>
            <span className="sr-only">Photo</span>
          </TH>
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
              <PersonPhoto person={person} size={32} />
            </TD>
            <TD>
              <TextLink href={`/admin/people/${person.id}`} className="font-medium">
                {person.name}
              </TextLink>
            </TD>
            <TD className="text-muted-foreground">
              {person.netId ?? <span className="text-subtle-foreground">-</span>}
            </TD>
            <TD className="text-muted-foreground">
              {person.contactEmail ?? <span className="text-subtle-foreground">-</span>}
            </TD>
            <TD className="text-muted-foreground tabular-nums">
              {person._membershipCount ?? 0}
            </TD>
            <TD>
              {/* The shared badges, not a third hand-rolled copy. This rendered
                  a bare two-letter code with no accessible name, so the whole
                  meaning of the cell was available to sighted mouse users and
                  nobody else.

                  No `department`: this roster is not department-scoped, so the
                  clinic-wide interpreting bar applies -- which is exactly what
                  CapabilityBadges falls back to when it is omitted. No score is
                  passed either, so the Spanish badge renders plain; adding one
                  would mean a new query on a page that does not need it, and an
                  unscored badge is the same thing this cell already showed. */}
              <span className="flex flex-wrap gap-1">
                <CapabilityBadges person={person} />
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
