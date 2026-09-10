import type { AuditRow } from "@/modules/admin/services/audit";
import { DateTime } from "@/platform/dates/display";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { ListEmpty } from "@/platform/ui/list-empty";

function truncate(s: string | null | undefined, max = 12): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function AuditTable({
  rows,
  filtered = false,
}: {
  rows: AuditRow[];
  /** Whether the page applied a filter. See ListEmpty. */
  filtered?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <Card pad={false}>
        <ListEmpty
          filtered={filtered}
          noun="audit entries"
          emptyDescription="Every change staff make to a record is recorded here."
        />
      </Card>
    );
  }

  return (
    <Table>
      <THead>
        <tr>
          <TH>When</TH>
          <TH>Actor</TH>
          <TH>Action</TH>
          <TH>Entity</TH>
          <TH>Details</TH>
        </tr>
      </THead>
      <tbody>
        {rows.map((row) => {
          const actor = row.actorName ?? row.actorPersonId ?? "system";
          const hasDetails = row.before != null || row.after != null;

          return (
            <TR key={row.id}>
              <TD className="whitespace-nowrap text-muted-foreground text-xs">
                <DateTime value={row.createdAt} />
              </TD>
              <TD className="max-w-[140px] truncate text-xs text-foreground-soft">
                {actor}
              </TD>
              <TD>
                <Badge tone="default">{row.action}</Badge>
              </TD>
              <TD className="text-xs text-foreground-soft">
                <span className="font-medium">{row.entityType}</span>
                {row.entityId && (
                  <span className="ml-1 text-subtle-foreground" title={row.entityId}>
                    {truncate(row.entityId)}
                  </span>
                )}
              </TD>
              <TD>
                {hasDetails ? (
                  <details>
                    <summary className="text-xs text-brand-fg hover:underline">
                      view
                    </summary>
                    {/* Scrollable, so it needs a keyboard route in. Unconditional
                        rather than measured: it sits inside a collapsed <details>,
                        so the stop only exists once someone has expanded it. */}
                    <pre
                      tabIndex={0}
                      className="mt-2 max-w-xl overflow-x-auto rounded bg-muted p-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                    >
                      {JSON.stringify({ before: row.before, after: row.after }, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </TD>
            </TR>
          );
        })}
      </tbody>
    </Table>
  );
}
