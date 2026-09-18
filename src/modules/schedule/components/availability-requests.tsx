/**
 * Availability change requests for one department, on /schedule/requests.
 *
 * The counterpart to PendingRequests beside it, for a different kind of ask: not
 * "let me out of this shift" but "the dates my application recorded are wrong".
 * The request is free text the volunteer wrote at onboarding, so approving it
 * cannot compute anything. The director reads what they asked for, edits the
 * ticked dates, and saves. That is why this card carries the whole availability
 * grid rather than an Approve button: the decision IS the new set of dates.
 *
 * Server component: no "use client" directive.
 */

import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card, cardClasses } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Input } from "@/platform/ui/input";
import { EmptyState } from "@/platform/ui/empty-state";
import { SectionHeader } from "@/platform/ui/section-header";
import { formatDateOnly, isoDateKey } from "@/platform/dates";
import { displayDate } from "@/modules/schedule/engine/display";
import { BUILDER_AVAILABILITY_PILL_CLASS, builderReadOnlyPillClass } from "./availability-pill";
import { sortClinicDates } from "./clinic-date-order";
import type { AvailabilityRequestRow } from "@/modules/schedule/services/availability-requests";

/** "Aug 28", matching the decided list on the shift-request card beside this one. */
const SETTLED_DATE_OPTS: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

/** Where the member's current availability came from, most authoritative first. */
const TIER_LABEL: Record<AvailabilityRequestRow["tier"], string> = {
  DIRECTOR: "Director override",
  SELF: "Self-reported",
  BASELINE: "From their application",
};

const TIER_TONE: Record<AvailabilityRequestRow["tier"], "success" | "default" | "warning"> = {
  DIRECTOR: "success",
  SELF: "default",
  BASELINE: "warning",
};

type AvailabilityRequestsProps = {
  rows: AvailabilityRequestRow[];
  /** The term's clinic calendar: every date the director can tick. */
  clinicDates: Date[];
  applyAction: (fd: FormData) => Promise<void>;
  dismissAction: (fd: FormData) => Promise<void>;
  /**
   * The settings-resolved display zone, for the decision timestamps below. A
   * clinic date is a UTC-anchored calendar marker and must NOT use this; a
   * decidedAt is a real instant and must.
   */
  timeZone: string;
};

export function AvailabilityRequests({
  rows,
  clinicDates,
  applyAction,
  dismissAction,
  timeZone,
}: AvailabilityRequestsProps) {
  const pendingRows = rows.filter((r) => r.decision === null);
  const decidedRows = rows.filter((r) => r.decision !== null);

  if (rows.length === 0) return null;

  // Sorted for the checkbox order. A copy, never the prop: Term.clinicDates
  // carries no ordering guarantee and is handed to sibling components by
  // reference in the same request.
  const sortedClinicDates = sortClinicDates(clinicDates);

  return (
    <section className={`${cardClasses({ pad: "tight" })} flex flex-col gap-3`}>
      <div className="flex items-center gap-2">
        <SectionHeader as="h2" level="card">Availability changes</SectionHeader>
        {pendingRows.length > 0 && (
          <Badge tone="warning" count>
            {pendingRows.length}
          </Badge>
        )}
      </div>

      {pendingRows.length === 0 && (
        <EmptyState inline>No availability changes waiting.</EmptyState>
      )}

      {pendingRows.map((row) => {
        const availKeys = new Set(row.currentDates.map((d) => isoDateKey(d)));
        // Someone accepted but not yet promoted has no TermMembership, and the
        // override is written to one. Their dates are shown read-only, which is
        // the honest picture: what their application said is the whole of what is
        // known, and there is nothing yet to correct. Dismiss stays available so
        // the row can still be cleared.
        const canApply = row.membershipId !== null;

        return (
          <Card key={row.contractId} size="compact" pad={false} className="px-3 py-3 flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{row.personName}</span>
              <Badge tone={TIER_TONE[row.tier]}>{TIER_LABEL[row.tier]}</Badge>
              {!canApply && <Badge tone="default">Not on the roster yet</Badge>}
            </div>

            {/* pre-line: this is a paragraph the member wrote, often a list of
                dates, and collapsing its line breaks runs the dates together. */}
            <p className="whitespace-pre-line break-words text-sm text-foreground-soft [overflow-wrap:anywhere]">
              {row.request}
            </p>

            {canApply ? (
              <>
                <p className="text-xs text-subtle-foreground">
                  Their availability now. Tick what it should be, then save.
                </p>
                {/* Keyed on the server state so an apply/dismiss soft nav remounts
                    the form and the uncontrolled defaultChecked boxes re-read it,
                    the same guard the builder's override form carries (#9). */}
                <form
                  key={`${row.tier}:${[...availKeys].sort().join(",")}`}
                  action={applyAction}
                  className="flex flex-col gap-3"
                >
                  <input type="hidden" name="contractId" value={row.contractId} />
                  <input type="hidden" name="departmentId" value={row.departmentId} />
                  <div className="flex flex-wrap gap-2">
                    {sortedClinicDates.map((d) => {
                      const key = isoDateKey(d);
                      return (
                        <label key={key} className={BUILDER_AVAILABILITY_PILL_CLASS}>
                          <Checkbox name="dates" value={key} defaultChecked={availKeys.has(key)} />
                          {displayDate(key)}
                        </label>
                      );
                    })}
                  </div>
                  <div>
                    <Button type="submit" variant="outline" size="sm">
                      Apply availability
                    </Button>
                  </div>
                </form>
              </>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {sortedClinicDates.map((d) => {
                    const key = isoDateKey(d);
                    return (
                      <span key={key} className={builderReadOnlyPillClass(availKeys.has(key))}>
                        {displayDate(key)}
                      </span>
                    );
                  })}
                </div>
                <p className="text-xs text-subtle-foreground">
                  They are not on this term&apos;s roster yet, so there is no availability to
                  change. Apply it from the schedule builder once the roster is built, or dismiss
                  this to clear it.
                </p>
              </>
            )}

            <form action={dismissAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="contractId" value={row.contractId} />
              <input type="hidden" name="departmentId" value={row.departmentId} />
              <Input
                name="dismissNote"
                aria-label="Note about this decision"
                placeholder="Note (optional)"
                className="flex-1 min-w-32 py-1 text-xs"
              />
              {/* Dismissing is how a request leaves the list without a change, so
                  it confirms like the apply beside it. */}
              <ConfirmButton
                label="Dismiss"
                confirmLabel="Dismiss this request without changing their availability?"
                size="sm"
              />
            </form>
          </Card>
        );
      })}

      {decidedRows.length > 0 && (
        <div className="border-t border-border-subtle pt-2 flex flex-col gap-1.5">
          <SectionHeader as="h3">Recent decisions</SectionHeader>
          {decidedRows.map((row) => {
            const decision = row.decision!;
            return (
              <div key={row.contractId} className="text-xs text-subtle-foreground">
                <p>
                  {row.personName}:{" "}
                  <span
                    className={
                      decision.outcome === "APPLIED" ? "text-success-foreground" : "text-foreground-soft"
                    }
                  >
                    {decision.outcome === "APPLIED" ? "availability updated" : "dismissed"}
                  </span>{" "}
                  by {decision.decidedByName} on{" "}
                  {formatDateOnly(decision.decidedAt, timeZone, SETTLED_DATE_OPTS)}
                  {decision.note ? ` -- ${decision.note}` : ""}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
