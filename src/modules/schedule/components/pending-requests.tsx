/**
 * Pending Requests panel for the schedule builder Saturday view.
 *
 * Shows PENDING requests with approve/deny actions, and a collapsed list
 * of recently decided requests.
 *
 * Server component: no "use client" directive.
 */

import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Input } from "@/platform/ui/input";
import { displayDate } from "@/modules/schedule/engine/display";
import { isoDateKey } from "@/platform/dates";
import type { RequestRow } from "@/modules/schedule/services/requests";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type PendingRequestsProps = {
  rows: RequestRow[];
  approveAction: (fd: FormData) => Promise<void>;
  denyAction: (fd: FormData) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PendingRequests({
  rows,
  approveAction,
  denyAction,
}: PendingRequestsProps) {
  const pendingRows = rows.filter((r) => r.request.status === "PENDING");
  const decidedRows = rows.filter((r) => r.request.status !== "PENDING");

  if (rows.length === 0) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-700 mb-2">Pending Requests</h2>
        <p className="text-sm text-slate-400">No requests.</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-4 py-3 flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-slate-700">
        Pending Requests
        {pendingRows.length > 0 && (
          <Badge tone="warning" className="ml-2">
            {pendingRows.length}
          </Badge>
        )}
      </h2>

      {pendingRows.length === 0 && (
        <p className="text-sm text-slate-400">No pending requests.</p>
      )}

      {/* Pending rows with approve/deny actions */}
      {pendingRows.map(({ request, requesterName, targetName }) => {
        const requesterDateLabel = displayDate(isoDateKey(request.requesterDate));

        const typeLabel =
          request.targetId == null
            ? "Drop"
            : `Swap with ${targetName ?? "unknown"} on ${
                request.targetDate ? displayDate(isoDateKey(request.targetDate)) : "?"
              }`;

        return (
          <div
            key={request.id}
            className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 flex flex-col gap-2"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{requesterName}</span>
                <span className="text-xs text-slate-500">
                  {typeLabel} on {requesterDateLabel}
                </span>
                {request.note && (
                  <span className="text-xs text-slate-500 italic">{request.note}</span>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Approve */}
              <form action={approveAction}>
                <input type="hidden" name="requestId" value={request.id} />
                <ConfirmButton label="Approve" confirmLabel="Approve this request?" />
              </form>

              {/* Deny (with optional note) */}
              <form action={denyAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="requestId" value={request.id} />
                <Input
                  name="denyNote"
                  aria-label="Denial reason"
                  placeholder="Reason (optional)"
                  className="flex-1 min-w-32 py-1 text-xs"
                />
                <Button type="submit" variant="danger" size="sm">
                  Deny
                </Button>
              </form>
            </div>
          </div>
        );
      })}

      {/* Decided rows (collapsed muted list) */}
      {decidedRows.length > 0 && (
        <div className="border-t border-slate-100 pt-2 flex flex-col gap-1">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
            Recent decisions
          </h3>
          {decidedRows.map(({ request, requesterName, decidedByName }) => (
            <p key={request.id} className="text-xs text-slate-400">
              {requesterName}: {" "}
              <span
                className={
                  request.status === "APPROVED"
                    ? "text-success"
                    : request.status === "DENIED"
                      ? "text-critical"
                      : "text-slate-400"
                }
              >
                {request.status.toLowerCase()}
              </span>
              {decidedByName ? ` by ${decidedByName}` : ""}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
