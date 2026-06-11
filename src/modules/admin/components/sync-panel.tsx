/**
 * SyncPanel: server component rendering the sync health dashboard.
 *
 * Displays mirror-enabled status, worker heartbeat, outbox stats, FAILED
 * outbox rows with a retry action, and mirror drift log entries.
 *
 * The "Retry all failed" form targets a server action defined in the page.
 * The action is passed as a prop so this component stays testable and the
 * page owns the permission re-check.
 */

import type { AuditLog, Outbox } from "@prisma/client";
import type { SyncOverview } from "@/modules/admin/services/sync";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { StatCard } from "@/platform/ui/stat-card";
import { Alert } from "@/platform/ui/alert";
import { ALL_PEOPLE_FIELDS } from "@/platform/airtable/fields";

// ---------------------------------------------------------------------------
// Field ID → logical name reverse lookup
// ---------------------------------------------------------------------------

/** Maps Airtable field ids (e.g. "fldpyuv6yjNET25Ok") to logical names (e.g. "name"). */
const FIELD_ID_TO_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ALL_PEOPLE_FIELDS).map(([name, id]) => [id, name]),
);

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatUtc(date: Date): string {
  return (
    date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      hour12: false,
    }) + " UTC"
  );
}

function truncate(s: string | null | undefined, max = 16): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/**
 * Human-readable relative time like "32s ago" or "5m ago".
 * Only used for values within the last few minutes.
 */
function relativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FailuresTable({ rows }: { rows: Outbox[] }) {
  if (rows.length === 0) {
    return (
      <Card pad={false} className="px-6 py-8 text-center text-sm text-slate-500">
        No failed outbox rows.
      </Card>
    );
  }

  return (
    <Table>
      <THead>
        <tr>
          <TH>Entity</TH>
          <TH>Attempts</TH>
          <TH>Last Error</TH>
          <TH>Created</TH>
        </tr>
      </THead>
      <tbody>
        {rows.map((row) => (
          <TR key={row.id}>
            <TD className="text-xs text-slate-600">
              <span className="font-medium">{row.entityType}</span>{" "}
              <span className="text-slate-400" title={row.entityId}>
                {truncate(row.entityId)}
              </span>
            </TD>
            <TD className="text-xs text-slate-600">{row.attempts}</TD>
            <TD className="text-xs text-slate-500">
              <span title={row.lastError ?? undefined}>
                {row.lastError ? truncate(row.lastError, 48) : null}
              </span>
            </TD>
            <TD className="whitespace-nowrap text-xs text-slate-400">
              {formatUtc(row.createdAt)}
            </TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}

function DriftTable({ rows }: { rows: AuditLog[] }) {
  if (rows.length === 0) {
    return (
      <Card pad={false} className="px-6 py-8 text-center text-sm text-slate-500">
        No drift corrections recorded.
      </Card>
    );
  }

  return (
    <Table>
      <THead>
        <tr>
          <TH>When</TH>
          <TH>Entity ID</TH>
          <TH>Changed Fields</TH>
        </tr>
      </THead>
      <tbody>
        {rows.map((row) => {
          // Extract field names from the after JSON keys, mapping ids to logical names.
          const changedFields =
            row.after != null &&
            typeof row.after === "object" &&
            !Array.isArray(row.after)
              ? Object.keys(row.after as Record<string, unknown>)
                  .map((id) => FIELD_ID_TO_NAME[id] ?? id)
                  .join(", ")
              : "";

          return (
            <TR key={row.id}>
              <TD className="whitespace-nowrap text-xs text-slate-400">
                {formatUtc(row.createdAt)}
              </TD>
              <TD className="text-xs text-slate-500" title={row.entityId ?? undefined}>
                {row.entityId ? truncate(row.entityId) : null}
              </TD>
              <TD className="text-xs text-slate-600">{changedFields}</TD>
            </TR>
          );
        })}
      </tbody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

type SyncPanelProps = {
  overview: SyncOverview;
  /** Requeued count from the most recent retry; shown as a quiet status line. */
  requeued?: number;
  /** Server action for the retry form. */
  retryAction: () => Promise<void>;
};

export function SyncPanel({ overview, requeued, retryAction }: SyncPanelProps) {
  const { mirrorEnabled, targetBaseId, worker, outbox, failures, drift } = overview;

  return (
    <div className="space-y-8">
      {/* Mirror-disabled banner */}
      {!mirrorEnabled && (
        <Alert tone="warning">
          Mirror is disabled. Outbox rows will accumulate until the FA26 cutover
          enables it.
        </Alert>
      )}

      {/* Status cards */}
      <section aria-label="Status" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {/* Mirror card */}
        <StatCard label="Mirror">
          <div className="mt-2 flex flex-col gap-1">
            {mirrorEnabled ? (
              <Badge tone="success">Enabled</Badge>
            ) : (
              <Badge tone="warning">Disabled</Badge>
            )}
            {targetBaseId && (
              <p className="text-xs text-slate-400" title={targetBaseId}>
                {truncate(targetBaseId, 24)}
              </p>
            )}
          </div>
        </StatCard>

        {/* Worker heartbeat card */}
        <StatCard label="Worker">
          <div className="mt-2 flex flex-col gap-1">
            {worker.ok ? (
              <>
                <Badge tone="success">Healthy</Badge>
                {worker.beatAt && (
                  <p className="text-xs text-slate-400">{relativeTime(worker.beatAt)}</p>
                )}
              </>
            ) : (
              <>
                <Badge tone="critical">No heartbeat</Badge>
                {worker.beatAt && (
                  <p className="text-xs text-slate-400">{formatUtc(worker.beatAt)}</p>
                )}
              </>
            )}
          </div>
        </StatCard>

        {/* Pending card */}
        <StatCard label="Outbox Pending" value={outbox.pending} />

        {/* Failed card */}
        <StatCard
          label="Outbox Failed"
          value={outbox.failed}
          tone={outbox.failed > 0 ? "critical" : "default"}
        />

        {/* Sent last 24h card */}
        <StatCard label="Sent (24h)" value={outbox.sentLast24h} />
      </section>

      {/* Failures section */}
      <section aria-label="Failures">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-800">Failed Rows</h2>
          {failures.length > 0 && (
            <form action={retryAction}>
              <ConfirmButton
                label="Retry all failed"
                confirmLabel="Confirm retry?"
              />
            </form>
          )}
        </div>

        {requeued !== undefined && requeued > 0 && (
          <p className="mb-3 text-sm text-slate-500">
            Requeued {requeued} {requeued === 1 ? "row" : "rows"}.
          </p>
        )}

        <FailuresTable rows={failures} />
      </section>

      {/* Drift section */}
      <section aria-label="Drift">
        <h2 className="mb-3 text-base font-semibold text-slate-800">
          Drift Corrections
        </h2>
        <DriftTable rows={drift} />
      </section>
    </div>
  );
}
