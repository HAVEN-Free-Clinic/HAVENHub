import type { AuditRow } from "@/modules/admin/services/audit";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";

function formatUtc(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: false,
  }) + " UTC";
}

function truncate(s: string | null | undefined, max = 12): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) {
    return (
      <Card pad={false} className="px-6 py-12 text-center text-sm text-muted-foreground">
        No audit entries found.
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
                {formatUtc(row.createdAt)}
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
                    <pre className="mt-2 max-w-xl overflow-x-auto rounded bg-muted p-2 text-xs">
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
