import { requireModuleAccess } from "@/platform/auth/session";
import { Badge } from "@/platform/ui/badge";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { FormActions } from "@/platform/ui/form";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { StatCard } from "@/platform/ui/stat-card";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  mySchedule,
  updateMyAvailability,
  AvailabilityValidationError,
} from "@/modules/schedule/services/schedule";
import {
  createRequest,
  cancelRequest,
  eligibleSwapPartners,
  remindDirectors,
  RequestValidationError,
  RequestForbiddenError,
  RequestNotFoundError,
} from "@/modules/schedule/services/requests";
import { CalendarSubscribeSection } from "@/modules/schedule/calendar/subscribe-section";
import { issueAuditedFeedToken } from "@/modules/schedule/calendar/subscribe-actions";
import { captureEvent } from "@/platform/posthog/capture";
import { termGroup } from "@/platform/posthog/groups";
import { isoDateKey } from "@/modules/schedule/engine/map";
import { displayDate } from "@/modules/schedule/engine/display";
import { CalendarDate } from "@/platform/dates/display";
import { displayTodayKey } from "@/platform/dates/today";
import { Checkbox } from "@/platform/ui/checkbox";
import { Clock } from "lucide-react";
import { groupByMonth } from "@/modules/schedule/components/clinic-date-order";

type SwapPartner = { personId: string; name: string; dateKey: string };

export default async function MySchedulePage() {
  const session = await requireModuleAccess("schedule");
  // Evaluated per request (not at module load) so the "pending N days" gate
  // below stays accurate across warm server instances. `new Date()` (not
  // Date.now()) to match the codebase convention and satisfy react-hooks/purity.
  const now = new Date();
  // Resolved once for the whole page (not per shift card) -- every shift's
  // "has this passed" check compares against this same key.
  const todayKey = await displayTodayKey(now);

  // mySchedule spans every term the member currently belongs to: their live
  // term plus any next term they are already an active roster member of. The
  // page renders one section per term; the heading is suppressed when there's
  // only one so a member on just the live term (the common case) sees exactly
  // today's single-term layout.
  const { terms } = await mySchedule(session.personId);
  const showTermHeadings = terms.length > 1;

  // The section used to drive the top hero banner: the live term when the
  // member is on it, otherwise whichever term they do have (their next term).
  const primary = terms.find((t) => t.isLive) ?? terms[0] ?? null;

  // Look up eligible swap partners for every non-pending shift card concurrently
  // rather than awaiting each in series, so the page's swap data is one round of
  // parallel queries instead of an N-deep await waterfall. Done per term (each
  // term's shifts pass their own term id into eligibleSwapPartners) and all
  // terms are looked up in parallel too.
  const termSections = await Promise.all(
    terms.map(async (t) => {
      const swapPartnerEntries = await Promise.all(
        t.shifts
          .map((shift) => {
            const dateKey = isoDateKey(shift.clinicDate);
            return { dateKey, cardKey: `${dateKey}|${shift.department.id}`, departmentId: shift.department.id };
          })
          .filter(({ cardKey }) => !t.pendingRequests.has(cardKey))
          .map(async ({ dateKey, cardKey, departmentId }) => {
            const partners = await eligibleSwapPartners(session.personId, dateKey, departmentId, t.term.id);
            return [cardKey, partners] as const;
          }),
      );
      return { t, swapPartnersByKey: new Map<string, SwapPartner[]>(swapPartnerEntries) };
    }),
  );

  async function saveAvailabilityAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const termId = (formData.get("termId") as string | null) ?? "";
    const rawDates = formData.getAll("dates") as string[];
    const dates = rawDates.map((key) => new Date(key + "T12:00:00Z"));
    try {
      await updateMyAvailability(actor.personId, { termId, dates });
    } catch (err) {
      if (err instanceof AvailabilityValidationError) {
        redirect(`/schedule?error=validation&message=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect("/schedule?saved=1");
  }

  async function createRequestAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const termId = (formData.get("termId") as string | null) ?? "";
    const dateKey = (formData.get("dateKey") as string | null) ?? "";
    const departmentId = (formData.get("departmentId") as string | null) ?? "";
    const note = ((formData.get("note") as string | null) ?? "").trim() || undefined;
    const partnerRaw = (formData.get("partner") as string | null) ?? "";
    const kind = (formData.get("kind") as string | null) ?? "";
    if (kind === "swap" && !partnerRaw) {
      redirect(`/schedule?error=validation&message=${encodeURIComponent("Select a swap partner before submitting.")}`);
    }
    let targetId: string | undefined;
    let targetDateKey: string | undefined;
    if (partnerRaw) {
      const pipeIdx = partnerRaw.indexOf("|");
      if (pipeIdx > 0) {
        targetId = partnerRaw.slice(0, pipeIdx);
        targetDateKey = partnerRaw.slice(pipeIdx + 1);
      }
    }
    try {
      await createRequest(actor.personId, { termId, requesterDateKey: dateKey, departmentId, targetId, targetDateKey, note });
    } catch (err) {
      if (err instanceof RequestValidationError || err instanceof RequestForbiddenError) {
        redirect(`/schedule?error=validation&message=${encodeURIComponent((err as Error).message)}`);
      }
      throw err;
    }
    await captureEvent({
      event: "shift_change_requested",
      distinctId: actor.personId,
      properties: { department_id: departmentId, request_kind: kind || (targetId ? "swap" : "drop"), date_key: dateKey },
      // Attribute the request to its own term (may be the next/PLANNING term), not the live one.
      groups: termGroup(termId),
    });
    revalidatePath("/schedule");
    redirect("/schedule?requested=1");
  }

  async function cancelRequestAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const requestId = (formData.get("requestId") as string | null) ?? "";
    try {
      await cancelRequest(actor.personId, requestId);
    } catch (err) {
      if (err instanceof RequestValidationError || err instanceof RequestForbiddenError || err instanceof RequestNotFoundError) {
        redirect(`/schedule?error=validation&message=${encodeURIComponent((err as Error).message)}`);
      }
      throw err;
    }
    revalidatePath("/schedule");
    redirect("/schedule");
  }

  const roleBadgeTone: Record<string, "default" | "warning" | "brand"> = {
    DIRECTOR: "brand",
    VOLUNTEER: "default",
    SHADOW: "warning",
  };

  async function remindDirectorsAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const requestId = (formData.get("requestId") as string | null) ?? "";
    let sent = 0;
    try {
      sent = await remindDirectors(actor.personId, requestId);
    } catch (err) {
      if (err instanceof RequestValidationError || err instanceof RequestForbiddenError || err instanceof RequestNotFoundError) {
        redirect(`/schedule?error=validation&message=${encodeURIComponent((err as Error).message)}`);
      }
      throw err;
    }
    revalidatePath("/schedule");
    // Tell the truth: when every approver was throttled (e.g. the daily cron or a
    // recent reminder already emailed them), nothing was enqueued (#113).
    redirect(sent > 0 ? "/schedule?message=reminded" : "/schedule?message=already_reminded");
  }

  // The same card renders on My Info. Both paths are revalidated from either
  // action so generating the link on one page cannot leave a stale empty card
  // on the other. The gate here is "schedule", not "my-info": a member who can
  // reach this page must be able to manage their own feed from it.
  async function generateFeedAction() {
    "use server";
    const s = await requireModuleAccess("schedule");
    await issueAuditedFeedToken(s.personId, "issue");
    revalidatePath("/schedule");
    revalidatePath("/my-info");
  }

  async function resetFeedAction() {
    "use server";
    const s = await requireModuleAccess("schedule");
    await issueAuditedFeedToken(s.personId, "reset");
    revalidatePath("/schedule");
    revalidatePath("/my-info");
  }

  return (
    <div>
      <div className="mb-8">
        <PageHeader
          title="My Schedule"
          description={
            primary
              ? `${primary.term.name}${
                  primary.shifts.length > 0
                    ? ` · ${[...new Set(primary.shifts.map((s) => s.department.name))].join(", ")}`
                    : " · No shifts assigned yet"
                }`
              : undefined
          }
          action={
            <Link href="#calendar-subscription" className={buttonClasses("outline", "sm", "min-h-11")}>
              Add to calendar
            </Link>
          }
        />
      </div>

      {termSections.length === 0 ? (
        <p className="text-sm text-subtle-foreground">No active term.</p>
      ) : (
        termSections.map(({ t, swapPartnersByKey }) => {
          // Whether to show the shift list at all -- this is purely about
          // whether shifts exist, not about live/next status. An empty list
          // still needs a message: which one depends on t.isLive below. A
          // non-live (next) term's shifts only appear once a department
          // publishes its schedule, so an empty list there means "not
          // published yet"; a live term's empty list means "no shifts
          // assigned yet" since the live schedule is never gated.
          const hasShifts = t.shifts.length > 0;
          const noShiftsMessage = t.isLive
            ? "No shifts assigned yet. Check back after the schedule is published."
            : `Your ${t.term.name} schedule isn't published yet. It will show here once it's ready.`;

          // Ordering comes from the service (clinicDate ascending), so upcoming keeps
          // that order and past is reversed to put the most recent first.
          const upcoming = t.shifts.filter((s) => isoDateKey(s.clinicDate) >= todayKey);
          const past = t.shifts.filter((s) => isoDateKey(s.clinicDate) < todayKey).reverse();
          // Group the next shift by date, not by index: a member working two
          // departments on the same Saturday must see both shifts under "Next
          // shift(s)", not one split off into "Later this term" (#89, whose
          // original fix lived in the sidebar this branch deleted).
          const nextKey = upcoming[0] ? isoDateKey(upcoming[0].clinicDate) : null;
          const nextShifts = nextKey ? upcoming.filter((s) => isoDateKey(s.clinicDate) === nextKey) : [];
          const laterShifts = nextKey ? upcoming.filter((s) => isoDateKey(s.clinicDate) !== nextKey) : [];
          const pastHasPendingRequest = past.some((s) =>
            t.pendingRequests.has(`${isoDateKey(s.clinicDate)}|${s.department.id}`),
          );

          function shiftCard(shift: (typeof t.shifts)[number], emphasised: boolean) {
            const dateKey = isoDateKey(shift.clinicDate);
            // >= today matches Task 2's guard: today is not past, so a
            // same-day shift still gets the full change form.
            const isPast = dateKey < todayKey;
            const cardKey = `${dateKey}|${shift.department.id}`;
            const pendingReq = t.pendingRequests.get(cardKey);
            const swapPartners = swapPartnersByKey.get(cardKey) ?? [];

            return (
              <Card
                key={cardKey}
                pad={false}
                className={emphasised ? "px-5 py-4 border-brand" : "px-5 py-4"}
              >
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="text-base font-bold text-foreground tabular-nums"><CalendarDate value={shift.clinicDate} /></span>
                  <Badge>{shift.department.code}</Badge>
                  <Badge tone={roleBadgeTone[shift.role] ?? "default"}>
                    {shift.role === "DIRECTOR" ? "Director" : shift.role === "VOLUNTEER" ? "Volunteer" : "Shadow"}
                  </Badge>
                  {shift.tags.triage && <Badge tone="default">Triage</Badge>}
                  {shift.tags.walkin && <Badge tone="default">Walk-in</Badge>}
                  {shift.tags.cc && <Badge tone="default">CC</Badge>}
                  {shift.tags.remote && <Badge tone="default">Remote</Badge>}
                </div>

                {/* Who is attending on this shift. The Attendings page is gated
                    to the directors who maintain it, so this is where the person
                    actually working the shift finds out. Absent until someone is
                    scheduled, rather than showing an empty "Attending:" row. */}
                {shift.attendings.length > 0 && (
                  <p className="mb-2 text-sm text-foreground-soft">
                    <span className="text-muted-foreground">
                      {shift.attendings.length > 1 ? "Attendings: " : "Attending: "}
                    </span>
                    {shift.attendings.map((a, i) => (
                      <span key={`${a.name}-${a.startTime}`}>
                        {i > 0 && ", "}
                        {a.name}
                        {a.slotLabel && (
                          <span className="text-muted-foreground">
                            {" "}
                            ({a.slotLabel} {a.startTime}-{a.endTime})
                          </span>
                        )}
                      </span>
                    ))}
                  </p>
                )}

                <div className="mt-2">
                  {pendingReq ? (
                    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted px-3 py-2">
                      <p className="text-sm text-foreground-soft flex-1 flex items-center gap-1.5">
                        <Clock className="h-4 w-4 shrink-0 text-warning" aria-hidden />
                        Change requested:{" "}
                        {pendingReq.targetId
                          ? `swap with ${pendingReq.target?.name ?? "unknown"} (${pendingReq.targetDate ? displayDate(isoDateKey(pendingReq.targetDate)) : "?"})`
                          : "drop"}{" "}
                        (pending director review)
                      </p>
                      <div className="flex items-center gap-2">
                        {Math.floor((now.getTime() - new Date(pendingReq.createdAt).getTime()) / (1000 * 60 * 60 * 24)) >= 5 && (
                          <form action={remindDirectorsAction}>
                            <input type="hidden" name="requestId" value={pendingReq.id} />
                            <ConfirmButton
                              label="Remind directors"
                              confirmLabel="Send a reminder to your directors?"
                            />
                          </form>
                        )}
                        <form action={cancelRequestAction}>
                          <input type="hidden" name="requestId" value={pendingReq.id} />
                          <ConfirmButton label="Cancel request" confirmLabel="Cancel this request?" />
                        </form>
                      </div>
                    </div>
                  ) : isPast ? (
                    <p className="text-sm text-subtle-foreground">This shift has passed.</p>
                  ) : (
                    <details className="group">
                      <summary className="text-xs font-medium text-subtle-foreground hover:text-foreground-soft list-none [&::-webkit-details-marker]:hidden">
                        <span className="underline underline-offset-2">Request a change</span>
                      </summary>
                      <div className="mt-3 flex flex-col gap-4 pl-1 border-t border-border-subtle pt-3">
                        <div>
                          <p className="text-xs font-medium text-muted-foreground mb-2">Request a drop</p>
                          <form action={createRequestAction} className="flex flex-wrap items-end gap-3">
                            <input type="hidden" name="termId" value={t.term.id} />
                            <input type="hidden" name="dateKey" value={dateKey} />
                            <input type="hidden" name="departmentId" value={shift.department.id} />
                            <input type="hidden" name="kind" value="drop" />
                            <div className="flex-1 min-w-48">
                              <Input name="note" placeholder="Optional note" aria-label="Note" />
                            </div>
                            <ConfirmButton label="Request drop" confirmLabel="Request this drop?" />
                          </form>
                        </div>
                        {swapPartners.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-muted-foreground mb-2">Request a swap</p>
                            <form action={createRequestAction} className="flex flex-wrap items-end gap-3">
                              <input type="hidden" name="termId" value={t.term.id} />
                              <input type="hidden" name="dateKey" value={dateKey} />
                              <input type="hidden" name="departmentId" value={shift.department.id} />
                              <input type="hidden" name="kind" value="swap" />
                              <div className="flex-1 min-w-56">
                                <Select name="partner" aria-label="Swap partner">
                                  <option value="">Select swap partner...</option>
                                  {swapPartners.map((p) => (
                                    <option key={`${p.personId}|${p.dateKey}`} value={`${p.personId}|${p.dateKey}`}>
                                      {p.name} ({displayDate(p.dateKey)})
                                    </option>
                                  ))}
                                </Select>
                              </div>
                              <Button type="submit" variant="outline">Request swap</Button>
                            </form>
                          </div>
                        )}
                        {swapPartners.length === 0 && (
                          <p className="text-sm text-subtle-foreground">No eligible swap partners for this shift.</p>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              </Card>
            );
          }

          return (
            <div key={t.term.id} className="mb-12 last:mb-0">
              {showTermHeadings && (
                <div className="mb-5 flex items-center gap-2">
                  <SectionHeader as="h2" level="title" className="text-xl">{t.term.name}</SectionHeader>
                  <Badge tone={t.isLive ? "brand" : "default"}>{t.isLive ? "Live" : "Next term"}</Badge>
                </div>
              )}

              {/* Quick-scan stats for this term: shift count, availability progress,
                  and pending request count. Each also gets a full readout in its own
                  section below; this row is just the at-a-glance summary. */}
              <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <StatCard label="Shifts this term" value={t.shifts.length} />
                <StatCard
                  label="Dates available"
                  value={
                    t.availability && t.clinicDates.length > 0
                      ? `${t.availability.dates.length} of ${t.clinicDates.length}`
                      : "-"
                  }
                />
                <StatCard
                  label="Pending requests"
                  value={t.pendingRequests.size}
                  tone={t.pendingRequests.size > 0 ? "warning" : "default"}
                />
              </div>

              <section>
                <SectionHeader as="h2" level="title" className="mb-5">My shifts</SectionHeader>

                {!hasShifts ? (
                  <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-subtle-foreground">
                    {noShiftsMessage}
                  </div>
                ) : (
                  <div className="flex flex-col gap-6">
                    {nextShifts.length > 0 && (
                      <div>
                        <SectionHeader as="h3" className="mb-2">
                          {nextShifts.length > 1 ? "Next shifts" : "Next shift"}
                        </SectionHeader>
                        <div className="flex flex-col gap-3">{nextShifts.map((s) => shiftCard(s, true))}</div>
                      </div>
                    )}
                    {laterShifts.length > 0 && (
                      <div>
                        <SectionHeader as="h3" className="mb-2">Later this term</SectionHeader>
                        <div className="flex flex-col gap-3">{laterShifts.map((s) => shiftCard(s, false))}</div>
                      </div>
                    )}
                    {past.length > 0 && (
                      <details className="group" open={pastHasPendingRequest}>
                        <summary className="cursor-pointer text-sm text-subtle-foreground hover:text-foreground-soft list-none [&::-webkit-details-marker]:hidden">
                          <span className="underline underline-offset-2">
                            {past.length} past shift{past.length === 1 ? "" : "s"}
                          </span>
                        </summary>
                        <div className="mt-3 flex flex-col gap-3">{past.map((s) => shiftCard(s, false))}</div>
                      </details>
                    )}
                  </div>
                )}
              </section>

              {/* My availability -- editable until this term's clinics start,
                  regardless of whether the schedule grid is showing yet. From
                  the first clinic date onward it goes read-only and changes run
                  through swap/drop requests instead. */}
              <section className="mt-10">
                <SectionHeader as="h2" level="title" className="mb-2">My availability</SectionHeader>
                <p className="text-sm text-subtle-foreground mb-5">
                  {t.availability === null
                    ? ""
                    : t.allDepartmentsOverridden
                    ? "Your availability is set by your director."
                    : t.availability.tier === "SELF"
                    ? "Based on your last update."
                    : "Based on your application responses."}
                </p>

                {t.availability === null ? (
                  <p className="text-sm text-subtle-foreground">You are not on that term&apos;s roster, so availability does not apply.</p>
                ) : (
                  <>
                    {t.legacyNote && (
                      <div className="mb-4 rounded-xl border border-border bg-muted px-3 py-2">
                        <p className="mb-1 text-xs font-medium text-muted-foreground">Note from the old scheduler:</p>
                        <p className="text-sm text-foreground-soft">{t.legacyNote}</p>
                      </div>
                    )}
                    {/* Per-department director overrides, shown read-only. A pin on
                        one department must not lock or shadow the member's editable
                        availability for their other departments (#26 / #61). */}
                    {t.directorOverrides.length > 0 && (
                      <div className="mb-4 rounded-xl border border-border bg-muted px-3 py-3">
                        <p className="mb-2 text-sm font-medium text-foreground">Set by your director</p>
                        <ul className="flex flex-col gap-1">
                          {t.directorOverrides.map((o) => (
                            <li key={o.departmentId} className="text-sm text-foreground-soft">
                              <span className="font-semibold text-foreground">{o.departmentCode}</span>:{" "}
                              {o.dates.length > 0
                                ? o.dates.map((d) => displayDate(isoDateKey(d))).join(", ")
                                : "unavailable for all dates"}
                            </li>
                          ))}
                        </ul>
                        {!t.allDepartmentsOverridden && (
                          <p className="mt-2 text-xs text-subtle-foreground">
                            Editing below won&apos;t change {t.directorOverrides.length === 1 ? "that department" : "those departments"}; your edits apply to your other departments. Ask a department director to adjust a pinned schedule.
                          </p>
                        )}
                      </div>
                    )}

                    {/* When every department is director-managed, a self-save would
                        move nothing, so withhold the editor rather than report a no-op
                        "saved" (#61). Otherwise the form is always editable. */}
                    {t.allDepartmentsOverridden ? (
                      <p className="text-sm text-subtle-foreground">Your availability is managed by your director, so there is nothing to edit here.</p>
                    ) : t.clinicDates.length === 0 ? (
                      // No clinic calendar yet: the checkbox grid would be empty and
                      // an empty save would wipe the application baseline to an empty
                      // SELF tier (#90). Explain instead of offering a destructive Save.
                      <p className="text-sm text-subtle-foreground">Clinic dates for this term haven&apos;t been set yet &mdash; check back once the calendar is published.</p>
                    ) : t.availabilityLocked ? (
                      // Clinics have started: the schedule built from this
                      // availability is live, so a silent edit here would desync
                      // it from the roster the clinic is working off. Show what
                      // they submitted, read-only, and point at the flow that
                      // does notify a director.
                      <div>
                        <div className="flex flex-wrap gap-2">
                          {t.availability.dates.length === 0 ? (
                            <p className="text-sm text-subtle-foreground">You marked yourself unavailable for every date.</p>
                          ) : (
                            t.availability.dates.map((d) => (
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
                          Availability is locked now that clinics have started. To change a shift you are
                          already on, use the swap or drop request on that shift above.
                        </p>
                      </div>
                    ) : (
                      <form action={saveAvailabilityAction}>
                        <input type="hidden" name="termId" value={t.term.id} />
                        <div className="flex flex-col gap-6">
                          {/* t.clinicDates is Term.clinicDates, a raw Postgres array
                              column with no ordering guarantee -- the check-in
                              feature's seed appends today's date to the end
                              regardless of where it falls chronologically.
                              groupByMonth sorts a copy before grouping, so the
                              month headings below always render chronologically
                              and never collide (see clinic-date-order.ts). */}
                          {groupByMonth(t.clinicDates).map((group) => (
                            <div key={group.key}>
                              <p className="text-xs font-semibold uppercase tracking-wide text-brand-fg mb-2">{group.month}</p>
                              <div className="flex flex-wrap gap-2">
                                {group.dates.map((d) => {
                                  const key = isoDateKey(d);
                                  const checked = t.availability!.dates.some((ad) => isoDateKey(ad) === key);
                                  return (
                                    <label key={key} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors whitespace-nowrap min-h-11 cursor-pointer ${checked ? "border-brand bg-brand/5 text-brand-fg font-semibold" : "border-border text-muted-foreground hover:border-brand/40"}`}>
                                      <Checkbox
                                        name="dates"
                                        value={key}
                                        defaultChecked={checked}
                                      />
                                      {displayDate(key)}
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                        <FormActions className="mt-4">
                          <Button type="submit">
                            Save availability
                          </Button>
                        </FormActions>
                      </form>
                    )}
                  </>
                )}
              </section>
            </div>
          );
        })
      )}

      {/* Calendar subscription. Outside the term loop on purpose: the feed is
          per person and spans every term, not per term. */}
      <section id="calendar-subscription" className="mt-10 scroll-mt-8">
        <CalendarSubscribeSection
          personId={session.personId}
          generateAction={generateFeedAction}
          resetAction={resetFeedAction}
        />
      </section>
    </div>
  );
}
