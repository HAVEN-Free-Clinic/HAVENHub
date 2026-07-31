import { requireModuleAccess } from "@/platform/auth/session";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { FormActions } from "@/platform/ui/form";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
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
import { captureEvent } from "@/platform/posthog/capture";
import { termGroup } from "@/platform/posthog/groups";
import { isoDateKey } from "@/modules/schedule/engine/map";
import { displayDate } from "@/modules/schedule/engine/display";
import { CalendarDate } from "@/platform/dates/display";
import { formatCalendarDate } from "@/platform/dates";
import { displayTodayKey } from "@/platform/dates/today";
import { Checkbox } from "@/platform/ui/checkbox";
import { Clock } from "lucide-react";

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

  return (
    <div>
      {/* Hero banner */}
      <div className="rounded-2xl bg-brand px-8 py-6 text-white mb-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-white/60 mb-1">{primary?.term.name ?? "Active Term"}</p>
        <h1 className="text-2xl font-bold tracking-tight">My Schedule</h1>
        {primary && primary.shifts.length > 0 ? (
          <p className="mt-1 text-sm text-white/70">
            {primary.shifts.length} shift{primary.shifts.length !== 1 ? "s" : ""} this term &middot;{" "}
            {[...new Set(primary.shifts.map((s) => s.department.name))].join(", ")}
          </p>
        ) : (
          <p className="mt-1 text-sm text-white/70">No shifts assigned yet</p>
        )}
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

          return (
            <div key={t.term.id} className="mb-12 last:mb-0">
              {showTermHeadings && (
                <div className="mb-5 flex items-center gap-2">
                  <h2 className="text-xl font-bold tracking-tight text-foreground">{t.term.name}</h2>
                  <Badge tone={t.isLive ? "brand" : "default"}>{t.isLive ? "Live" : "Next term"}</Badge>
                </div>
              )}

              <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_320px]">

                {/* Left column: shifts + availability */}
                <div>
                  {/* My shifts */}
                  <section>
                    <div className="flex items-center gap-3 mb-5">
                      <h2 className="text-lg font-bold text-foreground">My Shifts</h2>
                      <span className="rounded-full bg-foreground text-surface text-xs font-semibold px-2.5 py-0.5">{t.shifts.length} total</span>
                    </div>

                    {!hasShifts ? (
                      <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-subtle-foreground">
                        {noShiftsMessage}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {t.shifts.map((shift) => {
                          const dateKey = isoDateKey(shift.clinicDate);
                          // >= today matches Task 2's guard: today is not past, so a
                          // same-day shift still gets the full change form.
                          const isPast = dateKey < todayKey;
                          const cardKey = `${dateKey}|${shift.department.id}`;
                          const pendingReq = t.pendingRequests.get(cardKey);
                          const swapPartners = swapPartnersByKey.get(cardKey) ?? [];

                          return (
                            <Card key={cardKey} pad={false} className="px-5 py-4">
                              <div className="flex flex-wrap items-center gap-2 mb-2">
                                <span className="text-base font-bold text-foreground tabular-nums"><CalendarDate value={shift.clinicDate} /></span>
                                <span className="text-xs font-bold uppercase tracking-widest text-subtle-foreground">{shift.department.code}</span>
                                <Badge tone={roleBadgeTone[shift.role] ?? "default"}>
                                  {shift.role === "DIRECTOR" ? "Director" : shift.role === "VOLUNTEER" ? "Volunteer" : "Shadow"}
                                </Badge>
                                {shift.tags.triage && <Badge tone="default">Triage</Badge>}
                                {shift.tags.walkin && <Badge tone="default">Walk-in</Badge>}
                                {shift.tags.cc && <Badge tone="default">CC</Badge>}
                                {shift.tags.remote && <Badge tone="default">Remote</Badge>}
                              </div>

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
                        })}
                      </div>
                    )}
                  </section>

                  {/* My availability -- always editable pre-publish, regardless
                      of whether this term's schedule grid is showing yet. */}
                  <section className="mt-10">
                    <div className="flex items-center gap-3 mb-2">
                      <h2 className="text-lg font-bold text-foreground">My Availability</h2>
                    </div>
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
                        ) : (
                          <form action={saveAvailabilityAction}>
                            <input type="hidden" name="termId" value={t.term.id} />
                            <div className="flex flex-col gap-6">
                              {Object.entries(
                                t.clinicDates.reduce((acc, d) => {
                                  const month = formatCalendarDate(d, { month: "long", year: "numeric" });
                                  if (!acc[month]) acc[month] = [];
                                  acc[month].push(d);
                                  return acc;
                                }, {} as Record<string, Date[]>)
                              ).map(([month, dates]) => (
                                <div key={month}>
                                  <p className="text-xs font-semibold uppercase tracking-wide text-brand-fg mb-2">{month}</p>
                                  <div className="flex flex-wrap gap-2">
                                    {dates.map((d) => {
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

                {/* Right column: quick info sidebar */}
                <div className="flex flex-col gap-4">
                  <Card pad={false} className="px-5 py-4">
                    <p className="text-xs font-semibold uppercase tracking-widest text-subtle-foreground mb-3">This Term</p>
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-foreground-soft">Total shifts</span>
                        <span className="text-sm font-bold text-foreground">{t.shifts.length}</span>
                      </div>
                      {/* Distinct roles/departments across ALL of this term's shifts, not
                          just shifts[0] -- a member scheduled in two departments (or two
                          roles) was mis-summarised as a single one, contradicting the hero (#89). */}
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-foreground-soft">{t.shifts.some((s, _i, a) => s.role !== a[0].role) ? "Roles" : "Role"}</span>
                        <span className="text-sm font-bold text-foreground text-right">
                          {t.shifts.length > 0
                            ? [...new Set(t.shifts.map((s) => s.role))]
                                .map((r) => r.charAt(0) + r.slice(1).toLowerCase())
                                .join(", ")
                            : "-"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-foreground-soft">{new Set(t.shifts.map((s) => s.department.code)).size > 1 ? "Departments" : "Department"}</span>
                        <span className="text-sm font-bold text-foreground text-right">
                          {t.shifts.length > 0
                            ? [...new Set(t.shifts.map((s) => s.department.code))].join(", ")
                            : "-"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-foreground-soft">Pending requests</span>
                        <span className="text-sm font-bold text-foreground">{t.pendingRequests.size}</span>
                      </div>
                    </div>
                  </Card>
                </div>

              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
