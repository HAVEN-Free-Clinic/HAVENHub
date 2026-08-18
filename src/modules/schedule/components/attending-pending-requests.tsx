/**
 * Faculty Relations' approve/deny panel for ATTENDING swap and drop requests.
 *
 * The twin of PendingRequests, kept separate rather than generalised: a
 * volunteer request names a department and a date, an attending request names a
 * clinic day and a COLUMN, and the two summaries have nothing in common past the
 * word "swap". One component taking a union of both row types would have been a
 * component with two disjoint render paths inside it.
 *
 * Server component: no "use client" directive.
 */

import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card, cardClasses } from "@/platform/ui/card";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { SectionHeader } from "@/platform/ui/section-header";
import { displayDate } from "@/modules/schedule/engine/display";
import { isoDateKey } from "@/platform/dates";
import type { AttendingRequestRow } from "@/modules/schedule/services/attending-portal";

type Props = {
  rows: AttendingRequestRow[];
  approveAction: (fd: FormData) => Promise<void>;
  denyAction: (fd: FormData) => Promise<void>;
  /** The display-zone "today" key. Resolved by the caller: displayTodayKey() is
   *  async and reads settings through Prisma, so it cannot run from here. */
  todayKey: string;
};

export function AttendingPendingRequests({ rows, approveAction, denyAction, todayKey }: Props) {
  const pendingRows = rows.filter((r) => r.status === "PENDING");
  const decidedRows = rows.filter((r) => r.status !== "PENDING");

  return (
    <section className={`${cardClasses({ pad: false })} px-4 py-3 flex flex-col gap-3`}>
      <div className="flex items-center gap-2">
        <SectionHeader as="h2" level="title" className="text-sm">Attending requests</SectionHeader>
        {pendingRows.length > 0 && <Badge tone="warning">{pendingRows.length}</Badge>}
      </div>

      {pendingRows.length === 0 && (
        <p className="text-sm text-subtle-foreground">No pending attending requests.</p>
      )}

      {pendingRows.map((r) => {
        const requesterKey = isoDateKey(r.requesterDate);
        const targetKey = r.target ? isoDateKey(r.target.clinicDate) : undefined;
        // Mirrors approveAttendingRequest's own guard: >= today, so a same-day
        // request is still approvable. Approving a stale one would delete or move
        // an assignment that is now history, so Approve is disabled and Deny is
        // the disposition left.
        const isStale = requesterKey < todayKey || (targetKey !== undefined && targetKey < todayKey);

        return (
          <Card key={r.id} size="compact" pad={false} className="px-3 py-2 flex flex-col gap-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{r.requester.name}</span>
                <span className="text-xs text-muted-foreground">
                  {r.target
                    ? `Swap with ${r.target.name} on ${displayDate(targetKey!)}`
                    : "Drop"}{" "}
                  &mdash; {r.requesterSlotLabel} on {displayDate(requesterKey)}
                </span>
                {/* A drop leaves the column short. Say so here, where the decision
                    is made, rather than making Faculty Relations open the coverage
                    view to find out what approving it costs. */}
                {!r.target && (
                  <span className="text-xs text-warning">
                    Approving leaves {r.requesterSlotLabel} unstaffed on this date.
                  </span>
                )}
                {r.note && <span className="text-xs text-muted-foreground italic">{r.note}</span>}
              </div>
              {isStale && <Badge tone="critical">Date passed</Badge>}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <form action={approveAction}>
                <input type="hidden" name="requestId" value={r.id} />
                <ConfirmButton
                  label="Approve"
                  confirmLabel={
                    r.target
                      ? "Approve this swap? Both attendings' dates will be exchanged."
                      : "Approve this drop? The column will be left unstaffed on that date."
                  }
                  disabled={isStale}
                  title={isStale ? "This clinic date has passed. Deny instead." : undefined}
                />
              </form>
              <form action={denyAction}>
                <input type="hidden" name="requestId" value={r.id} />
                <Button type="submit" variant="danger" size="sm">Deny</Button>
              </form>
            </div>
          </Card>
        );
      })}

      {decidedRows.length > 0 && (
        <div className="border-t border-border-subtle pt-2 flex flex-col gap-1">
          <SectionHeader as="h3">Recent decisions</SectionHeader>
          {decidedRows.map((r) => (
            <p key={r.id} className="text-xs text-subtle-foreground">
              {r.requester.name}:{" "}
              <span
                className={
                  r.status === "APPROVED"
                    ? "text-success"
                    : r.status === "DENIED"
                      ? "text-critical"
                      : "text-subtle-foreground"
                }
              >
                {r.status.toLowerCase()}
              </span>{" "}
              &mdash; {r.isSwap ? "swap" : "drop"}, {r.requesterSlotLabel} on{" "}
              {displayDate(isoDateKey(r.requesterDate))}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
