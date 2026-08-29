/**
 * The attending's own schedule, availability, and swap/drop controls, as they
 * appear on /schedule.
 *
 * A SECTION of My Schedule rather than a page of its own, because "just like
 * everyone else" is the requirement: an attending signs in and finds their
 * schedule where every other member finds theirs. It renders above the volunteer
 * sections, and both appear for the handful of people who are genuinely both (a
 * PA who also volunteers, a faculty member who directs a department).
 *
 * Server component. The actions are passed in from the page so authorization
 * stays at the page boundary, matching CalendarSubscribeSection.
 */

import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { FormActions } from "@/platform/ui/form";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SectionHeader } from "@/platform/ui/section-header";
import { StatCard } from "@/platform/ui/stat-card";
import { CalendarDate } from "@/platform/dates/display";
import { Clock } from "lucide-react";
import { isoDateKey } from "../engine/map";
import { displayDate } from "../engine/display";
import { groupByMonth } from "./clinic-date-order";
import type { MyAttendingSchedule, AttendingSwapPartner } from "../services/attending-portal";

export type AttendingPortalSectionProps = {
  schedule: MyAttendingSchedule;
  /** Today's key in the DISPLAY zone, resolved once by the page. */
  todayKey: string;
  /** Eligible swap partners per "clinicDayId|slotId", resolved by the page. */
  swapPartnersByKey: Map<string, AttendingSwapPartner[]>;
  saveAvailabilityAction: (formData: FormData) => Promise<void>;
  createRequestAction: (formData: FormData) => Promise<void>;
  cancelRequestAction: (formData: FormData) => Promise<void>;
};

export function AttendingPortalSection({
  schedule,
  todayKey,
  swapPartnersByKey,
  saveAvailabilityAction,
  createRequestAction,
  cancelRequestAction,
}: AttendingPortalSectionProps) {
  const { attending, term, shifts, clinicDates, pendingRequests } = schedule;

  // Split on the same >= today rule the request guards use, so a card offering a
  // change is exactly a card whose date a request would be accepted for.
  const upcoming = shifts.filter((s) => isoDateKey(s.clinicDate) >= todayKey);
  const past = shifts.filter((s) => isoDateKey(s.clinicDate) < todayKey).reverse();

  const availableCount = schedule.availableDates?.length ?? null;

  function shiftCard(shift: (typeof shifts)[number], emphasised: boolean) {
    const cardKey = `${shift.clinicDayId}|${shift.slot.id}`;
    const pending = pendingRequests.get(cardKey);
    const partners = swapPartnersByKey.get(cardKey) ?? [];
    const isPast = isoDateKey(shift.clinicDate) < todayKey;

    return (
      <Card key={cardKey} pad={false} className={emphasised ? "px-5 py-4 border-brand" : "px-5 py-4"}>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-base font-bold text-foreground tabular-nums">
            <CalendarDate value={shift.clinicDate} />
          </span>
          <Badge>{shift.slot.label}</Badge>
          <span className="text-sm text-muted-foreground tabular-nums">
            {shift.slot.startTime}-{shift.slot.endTime}
          </span>
          {/* The on-call week runs FORWARD from this date, not during it (see
              ClinicDay.onCallAttendingId). Say so, or the badge reads as "you are
              on call during this shift", which is the opposite of the truth. */}
          {shift.onCall && <Badge tone="brand">On call the following week</Badge>}
          {shift.isClosed && <Badge tone="warning">Clinic closed</Badge>}
        </div>

        {shift.alongside.length > 0 && (
          <p className="mb-2 text-sm text-foreground-soft">
            <span className="text-muted-foreground">
              {shift.alongside.length > 1 ? "Covering with: " : "Covering with: "}
            </span>
            {shift.alongside.join(", ")}
          </p>
        )}

        <div className="mt-2">
          {pending ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted px-3 py-2">
              <p className="text-sm text-foreground-soft flex-1 flex items-center gap-1.5">
                <Clock className="h-4 w-4 shrink-0 text-warning" aria-hidden />
                Change requested:{" "}
                {pending.isSwap && pending.target
                  ? `swap with ${pending.target.name} (${displayDate(isoDateKey(pending.target.clinicDate))})`
                  : "drop"}{" "}
                (pending Faculty Relations review)
              </p>
              <form action={cancelRequestAction}>
                <input type="hidden" name="requestId" value={pending.id} />
                <ConfirmButton label="Withdraw request" confirmLabel="Withdraw this request?" />
              </form>
            </div>
          ) : isPast ? (
            <p className="text-sm text-subtle-foreground">This clinic date has passed.</p>
          ) : shift.isClosed ? (
            // A closed Saturday has no coverage to give up, so there is nothing
            // to request. Saying so beats a form that would be refused server-side.
            <p className="text-sm text-subtle-foreground">The clinic is closed this day.</p>
          ) : (
            <details className="group">
              <summary className="text-xs font-medium text-subtle-foreground hover:text-foreground-soft list-none [&::-webkit-details-marker]:hidden">
                <span className="underline underline-offset-2">Request a change</span>
              </summary>
              <div className="mt-3 flex flex-col gap-4 pl-1 border-t border-border-subtle pt-3">
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">Give up this date</p>
                  <form action={createRequestAction} className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="clinicDayId" value={shift.clinicDayId} />
                    <input type="hidden" name="slotId" value={shift.slot.id} />
                    <input type="hidden" name="kind" value="drop" />
                    <div className="flex-1 min-w-48">
                      <Input name="note" placeholder="Optional note" aria-label="Note" />
                    </div>
                    <ConfirmButton label="Request drop" confirmLabel="Request to drop this date?" />
                  </form>
                </div>
                {partners.length > 0 ? (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">
                      Swap with another {shift.slot.label} attending
                    </p>
                    <form action={createRequestAction} className="flex flex-wrap items-end gap-3">
                      <input type="hidden" name="clinicDayId" value={shift.clinicDayId} />
                      <input type="hidden" name="slotId" value={shift.slot.id} />
                      <input type="hidden" name="kind" value="swap" />
                      <div className="flex-1 min-w-56">
                        <Select name="partner" aria-label="Swap partner">
                          <option value="">Select swap partner...</option>
                          {partners.map((p) => (
                            <option
                              key={`${p.attendingId}|${p.clinicDayId}`}
                              value={`${p.attendingId}|${p.clinicDayId}|${p.slotId}`}
                            >
                              {p.name} ({displayDate(isoDateKey(p.clinicDate))})
                            </option>
                          ))}
                        </Select>
                      </div>
                      <Button type="submit" variant="outline">Request swap</Button>
                    </form>
                  </div>
                ) : (
                  // The column IS the qualification (see eligibleAttendingSwapPartners),
                  // so name it: "no partners" without the reason reads as a bug.
                  <p className="text-sm text-subtle-foreground">
                    Nobody else is scheduled on another date in the {shift.slot.label} column, so there is
                    no one to swap with. Request a drop instead and Faculty Relations will find cover.
                  </p>
                )}
              </div>
            </details>
          )}
        </div>
      </Card>
    );
  }

  return (
    <section className="mb-12">
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <SectionHeader as="h2" level="title" className="text-xl">
          My attending schedule
        </SectionHeader>
        {attending.specialty && <Badge>{attending.specialty.name}</Badge>}
        {!attending.isActive && <Badge tone="warning">Inactive</Badge>}
      </div>

      {!term ? (
        <p className="text-sm text-subtle-foreground">No active term.</p>
      ) : (
        <>
          <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label="Dates this term" value={shifts.length} />
            <StatCard
              label="Dates available"
              value={availableCount === null || clinicDates.length === 0 ? "-" : `${availableCount} of ${clinicDates.length}`}
            />
            <StatCard
              label="Pending requests"
              value={pendingRequests.size}
              tone={pendingRequests.size > 0 ? "warning" : "default"}
            />
          </div>

          {!attending.isActive && (
            <div className="mb-6 rounded-xl border border-border bg-muted px-3 py-2">
              <p className="text-sm text-foreground-soft">
                Your attending record is marked inactive, so you can view your past dates but not request
                changes. Contact Faculty Relations if that is wrong.
              </p>
            </div>
          )}

          <div className="mb-10">
            <SectionHeader as="h3" className="mb-2">Clinic dates you are covering</SectionHeader>
            {shifts.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-subtle-foreground">
                You are not on the {term.name} schedule yet. Faculty Relations builds it before the term
                starts, and it will show here once it is set.
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {upcoming.length > 0 && (
                  <div className="flex flex-col gap-3">
                    {upcoming.map((s, i) => shiftCard(s, i === 0))}
                  </div>
                )}
                {upcoming.length === 0 && (
                  <p className="text-sm text-subtle-foreground">No upcoming dates left this term.</p>
                )}
                {past.length > 0 && (
                  <details className="group" open={false}>
                    <summary className="cursor-pointer text-sm text-subtle-foreground hover:text-foreground-soft list-none [&::-webkit-details-marker]:hidden">
                      <span className="underline underline-offset-2">
                        {past.length} past date{past.length === 1 ? "" : "s"}
                      </span>
                    </summary>
                    <div className="mt-3 flex flex-col gap-3">{past.map((s) => shiftCard(s, false))}</div>
                  </details>
                )}
              </div>
            )}
          </div>

          <div>
            <SectionHeader as="h3" className="mb-2">Dates I can cover</SectionHeader>
            <p className="text-sm text-subtle-foreground mb-5">
              {schedule.availabilityUpdatedAt
                ? "Faculty Relations sees this while building the schedule. It does not change dates you are already on."
                : "Tell Faculty Relations which clinic dates you are able to cover this term."}
            </p>

            {clinicDates.length === 0 ? (
              <p className="text-sm text-subtle-foreground">
                Clinic dates for this term haven&apos;t been set yet &mdash; check back once the calendar is
                published.
              </p>
            ) : schedule.availabilityLocked ? (
              // Same rule as the volunteer side: once clinics are running, the grid
              // is live and a silent edit here would desync it from the sheet the
              // clinic is working off. Show what they submitted and point at the
              // flow Faculty Relations actually sees.
              <div>
                <div className="flex flex-wrap gap-2">
                  {schedule.availableDates === null ? (
                    <p className="text-sm text-subtle-foreground">You did not submit availability for this term.</p>
                  ) : schedule.availableDates.length === 0 ? (
                    <p className="text-sm text-subtle-foreground">You marked yourself unavailable for every date.</p>
                  ) : (
                    schedule.availableDates.map((d) => (
                      <span
                        key={isoDateKey(d)}
                        className="flex items-center rounded-full border border-border px-3 py-1.5 text-xs whitespace-nowrap text-muted-foreground"
                      >
                        {displayDate(isoDateKey(d))}
                      </span>
                    ))
                  )}
                </div>
                <p className="mt-4 text-sm text-subtle-foreground">
                  Availability is locked now that clinics have started. To change a date you are already
                  on, use the swap or drop request on that date above.
                </p>
              </div>
            ) : !attending.isActive ? (
              <p className="text-sm text-subtle-foreground">
                Your attending record is inactive, so there is nothing to set here.
              </p>
            ) : (
              <form action={saveAvailabilityAction}>
                <input type="hidden" name="termId" value={term.id} />
                <div className="flex flex-col gap-6">
                  {/* Term.clinicDates is a raw Postgres array with no ordering
                      guarantee; groupByMonth sorts a copy before grouping. Same
                      reason as the volunteer form. */}
                  {groupByMonth(clinicDates).map((group) => (
                    <div key={group.key}>
                      <p className="text-xs font-semibold uppercase tracking-wide text-brand-fg mb-2">
                        {group.month}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {group.dates.map((d) => {
                          const key = isoDateKey(d);
                          const checked = (schedule.availableDates ?? []).some((ad) => isoDateKey(ad) === key);
                          return (
                            // has-[:checked] styles the pill from the live checkbox, so a toggle gives
                            // instant feedback. Server-only styling left the pill unchanged on click,
                            // so people re-clicked and turned the date back off.
                            <label
                              key={key}
                              className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors whitespace-nowrap min-h-11 cursor-pointer border-border text-muted-foreground hover:border-brand/40 has-[:checked]:border-brand has-[:checked]:bg-brand/5 has-[:checked]:text-brand-fg has-[:checked]:font-semibold"
                            >
                              <Checkbox name="dates" value={key} defaultChecked={checked} />
                              {displayDate(key)}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <FormActions className="mt-4">
                  <Button type="submit">Save availability</Button>
                </FormActions>
              </form>
            )}
          </div>
        </>
      )}
    </section>
  );
}
