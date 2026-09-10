import type { AuditRow } from "@/modules/admin/services/audit";
import { DateTime } from "@/platform/dates/display";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { ListEmpty } from "@/platform/ui/list-empty";

/** Words the plain capitalisation below would get wrong. */
const PROPER: Record<string, string> = {
  ehs: "EHS",
  epic: "Epic",
  ynhh: "YNHH",
  mcp: "MCP",
  rhd: "RHD",
  rbac: "RBAC",
  hipaa: "HIPAA",
  srr: "SRR",
  itcm: "ITCM",
  intercom: "Intercom",
  gitbook: "GitBook",
};

function words(snake: string): string[] {
  return snake.split(/[_.]/).filter(Boolean).map((w) => PROPER[w] ?? w);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * "recruitment.application_submit" -> "Recruitment · Application submit".
 *
 * Generic rather than a label per code: there are over two hundred action
 * codes, written at call sites across every module, and a hand-kept map would
 * fall behind the first time someone added one. The log showed the raw code in
 * a badge, which read as developer output to the admins it is for.
 */
export function auditActionLabel(code: string): string {
  const [area, ...rest] = code.split(".");
  const areaLabel = capitalise(words(area).join(" "));
  if (rest.length === 0) return areaLabel;
  return `${areaLabel} · ${capitalise(words(rest.join(".")).join(" "))}`;
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
              <TD className="text-sm">
                <span className="font-medium text-foreground">{auditActionLabel(row.action)}</span>
                {/* The raw code stays: it is what the Action filter above matches. */}
                <span className="block font-mono text-[11px] text-subtle-foreground">{row.action}</span>
              </TD>
              <TD className="text-xs text-foreground-soft">
                <span className="font-medium">{row.entityType}</span>
                {/* In full, and selectable. It was cut to twelve characters with
                    the rest only in a hover title, so it could be neither read
                    nor copied into a search. */}
                {row.entityId && (
                  <span className="block break-all font-mono text-[11px] text-subtle-foreground">{row.entityId}</span>
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
