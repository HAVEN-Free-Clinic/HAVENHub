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
import { Card, cardClasses } from "@/platform/ui/card";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Input } from "@/platform/ui/input";
import { displayDate } from "@/modules/schedule/engine/display";
import { formatDateOnly, isoDateKey } from "@/platform/dates";
import type { RequestRow } from "@/modules/schedule/services/requests";
import { SectionHeader } from "@/platform/ui/section-header";

/**
 * "Aug 28". No year: the decided list is capped at the ten most recent
 * decisions of one term, so the year is noise next to the clinic date beside it
 * (displayDate omits it too).
 */
const SETTLED_DATE_OPTS: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type PendingRequestsProps = {
  rows: RequestRow[];
  approveAction: (fd: FormData) => Promise<void>;
  denyAction: (fd: FormData) => Promise<void>;
  /**
   * The display-zone "today" key (YYYY-MM-DD), used to mark requests whose
   * clinic date has already passed. displayTodayKey() is async and reads the
   * settings-resolved timezone (Prisma), so it can't be called from here --
   * the caller resolves it once and passes it down.
   */
  todayKey: string;
  /**
   * The settings-resolved display zone, for the decision timestamps in the
   * decided list. Passed in for the same reason todayKey is: resolving it reads
   * settings through Prisma and cannot happen in a sync component. A clinic date
   * is a UTC-anchored calendar marker and must NOT use this; a decidedAt is a
   * real instant and must.
   */
  timeZone: string;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PendingRequests({
  rows,
  approveAction,
  denyAction,
  todayKey,
  timeZone,
}: PendingRequestsProps) {
  const pendingRows = rows.filter((r) => r.request.status === "PENDING");
  const decidedRows = rows.filter((r) => r.request.status !== "PENDING");

  if (rows.length === 0) {
    return (
      <section className={`${cardClasses({ pad: false })} px-4 py-3`}>
        <SectionHeader as="h2" level="title" className="text-sm mb-2">Pending Requests</SectionHeader>
        <p className="text-sm text-subtle-foreground">No requests.</p>
      </section>
    );
  }

  return (
    <section className={`${cardClasses({ pad: false })} px-4 py-3 flex flex-col gap-3`}>
      <div className="flex items-center gap-2">
        <SectionHeader as="h2" level="title" className="text-sm">Pending Requests</SectionHeader>
        {pendingRows.length > 0 && (
          <Badge tone="warning" count>
            {pendingRows.length}
          </Badge>
        )}
      </div>

      {pendingRows.length === 0 && (
        <p className="text-sm text-subtle-foreground">No pending requests.</p>
      )}

      {/* Pending rows with approve/deny actions */}
      {pendingRows.map(({ request, requesterName, targetName }) => {
        const requesterDateKey = isoDateKey(request.requesterDate);
        const targetDateKey = request.targetDate ? isoDateKey(request.targetDate) : undefined;
        const requesterDateLabel = displayDate(requesterDateKey);

        // Mirrors approveRequest's own guard (requests.ts): >= today, so a
        // same-day request is still approvable. A stale request would be
        // refused server-side, so Approve is disabled here rather than left
        // to error; Deny is the only disposition left for it.
        const isStale =
          requesterDateKey < todayKey ||
          (targetDateKey !== undefined && targetDateKey < todayKey);

        const typeLabel =
          request.targetId == null
            ? "Drop"
            : `Swap with ${targetName ?? "unknown"} on ${
                request.targetDate ? displayDate(targetDateKey!) : "?"
              }`;

        return (
          <Card
            key={request.id}
            size="compact"
            pad={false}
            className="px-3 py-2 flex flex-col gap-2"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{requesterName}</span>
                <span className="text-xs text-muted-foreground">
                  {typeLabel} on {requesterDateLabel}
                </span>
                {request.note && (
                  <span className="text-xs text-muted-foreground italic">{request.note}</span>
                )}
              </div>
              {isStale && <Badge tone="critical">Date passed</Badge>}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Approve -- disabled once the clinic date has passed; the
                  server refuses it anyway (approveRequest's past-date guard). */}
              <form action={approveAction}>
                <input type="hidden" name="requestId" value={request.id} />
                <ConfirmButton
                  label="Approve"
                  confirmLabel="Approve this request?"
                  disabled={isStale}
                  title={isStale ? "This clinic date has passed. Deny instead." : undefined}
                />
              </form>

              {/* Deny (with optional note) -- always available; it's the only
                  disposition left once a request has gone stale. */}
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
          </Card>
        );
      })}

      {/* Decided rows (collapsed muted list).

          Each row names WHAT was decided as well as who and how it went. The
          list used to read "Bonnie Li: approved by Karthik Chetlapalli" and
          nothing else, so two requests from the same person were
          indistinguishable, and there was no way to tell a decision made this
          morning from one made a month ago. */}
      {decidedRows.length > 0 && (
        <div className="border-t border-border-subtle pt-2 flex flex-col gap-1.5">
          <SectionHeader as="h3">Recent decisions</SectionHeader>
          {decidedRows.map(({ request, requesterName, targetName, decidedByName }) => {
            const requesterDateLabel = displayDate(isoDateKey(request.requesterDate));
            const targetDateLabel = request.targetDate
              ? displayDate(isoDateKey(request.targetDate))
              : null;
            const summary =
              request.targetId == null
                ? `Drop: ${requesterDateLabel}`
                : `Swap: ${requesterDateLabel} with ${targetName ?? "unknown"}${
                    targetDateLabel ? ` (${targetDateLabel})` : ""
                  }`;
            // cancelRequest sets CANCELLED without stamping decidedAt -- a
            // withdrawal is not a director's decision -- so decidedAt is null on
            // every cancelled row. updatedAt is the moment the request reached
            // its final state either way, and is already what this list is
            // ordered by (see listDepartmentRequests).
            const settledAt = request.decidedAt ?? request.updatedAt;

            return (
              <div key={request.id} className="text-xs text-subtle-foreground">
                <p>
                  {requesterName}:{" "}
                  <span
                    className={
                      request.status === "APPROVED"
                        ? "text-success-foreground"
                        : request.status === "DENIED"
                          ? "text-critical-foreground"
                          : "text-subtle-foreground"
                    }
                  >
                    {request.status.toLowerCase()}
                  </span>
                  {decidedByName ? ` by ${decidedByName}` : ""}
                  {" "}on {formatDateOnly(settledAt, timeZone, SETTLED_DATE_OPTS)}
                </p>
                <p>{summary}</p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
