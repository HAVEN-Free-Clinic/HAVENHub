import { requireModuleAccess } from "@/platform/auth/session";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
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
  RequestValidationError,
  RequestForbiddenError,
  RequestNotFoundError,
} from "@/modules/schedule/services/requests";
import { isoDateKey } from "@/modules/schedule/engine/map";
import { displayDate } from "@/modules/schedule/engine/display";

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "-";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

type PageProps = {
  searchParams: Promise<{ error?: string; message?: string; saved?: string; requested?: string }>;
};

export default async function MySchedulePage({ searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const sp = await searchParams;

  const errorCode = sp.error ?? null;
  const errorMessage = errorCode
    ? errorCode === "validation" && sp.message
      ? decodeURIComponent(sp.message)
      : decodeURIComponent(errorCode)
    : null;

  const saved = sp.saved === "1";
  const requested = sp.requested === "1";

  const { term, shifts, availability, legacyNote, clinicDates, pendingRequests } =
    await mySchedule(session.personId);

  type SwapPartner = { personId: string; name: string; dateKey: string };
  const swapPartnersByKey = new Map<string, SwapPartner[]>();
  for (const shift of shifts) {
    const dateKey = isoDateKey(shift.clinicDate);
    const cardKey = `${dateKey}|${shift.department.id}`;
    if (!pendingRequests.has(cardKey)) {
      const partners = await eligibleSwapPartners(session.personId, dateKey, shift.department.id);
      swapPartnersByKey.set(cardKey, partners);
    }
  }

  async function saveAvailabilityAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const rawDates = formData.getAll("dates") as string[];
    const dates = rawDates.map((key) => new Date(key + "T12:00:00Z"));
    try {
      await updateMyAvailability(actor.personId, dates);
    } catch (err) {
      if (err instanceof AvailabilityValidationError) {
        redirect(`/schedule?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect("/schedule?saved=1");
  }

  async function createRequestAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
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
      await createRequest(actor.personId, { requesterDateKey: dateKey, departmentId, targetId, targetDateKey, note });
    } catch (err) {
      if (err instanceof RequestValidationError || err instanceof RequestForbiddenError) {
        redirect(`/schedule?error=validation&message=${encodeURIComponent((err as Error).message)}`);
      }
      throw err;
    }
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

  return (
    <div>
      {/* Hero banner */}
      <div className="rounded-xl bg-brand px-8 py-6 text-white mb-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-white/60 mb-1">{term?.name ?? "Active Term"}</p>
        <h1 className="text-2xl font-bold mb-1">My Schedule</h1>
        {shifts.length > 0 ? (
          <p className="text-sm text-white/70">
            {shifts.length} shift{shifts.length !== 1 ? "s" : ""} this term &middot;{" "}
            {[...new Set(shifts.map((s) => s.department.name))].join(", ")}
          </p>
        ) : (
          <p className="text-sm text-white/70">No shifts assigned yet</p>
        )}
      </div>

      {errorMessage && (
        <div role="alert" className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}
      {saved && (
        <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 font-medium">
          ✓ Availability saved successfully.
        </div>
      )}
      {requested && (
        <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 font-medium">
          ✓ Change request submitted. Your director will review it.
        </div>
      )}

      {!term ? (
        <p className="text-sm text-slate-400">No active term.</p>
      ) : (
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_320px]">

          {/* Left column: shifts + availability */}
          <div>
            {/* My shifts */}
            <section>
              <div className="flex items-center gap-3 mb-5">
                <h2 className="text-lg font-bold text-slate-800">My Shifts</h2>
                <span className="rounded-full text-white text-xs font-semibold px-2.5 py-0.5" style={{backgroundColor: "#1e3a5f"}}>{shifts.length} total</span>
              </div>

              {shifts.length === 0 ? (
                <div className="rounded-xl border-2 border-dashed border-slate-200 px-6 py-10 text-center text-sm text-slate-400">
                  No shifts assigned yet. Check back after the schedule is published.
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {shifts.map((shift) => {
                    const dateKey = isoDateKey(shift.clinicDate);
                    const cardKey = `${dateKey}|${shift.department.id}`;
                    const pendingReq = pendingRequests.get(cardKey);
                    const swapPartners = swapPartnersByKey.get(cardKey) ?? [];

                    const leftBorder =
                      shift.role === "DIRECTOR"
                        ? "border-l-4 border-l-brand"
                        : shift.role === "SHADOW"
                        ? "border-l-4 border-l-amber-400"
                        : "border-l-4 border-l-emerald-400";

                    return (
                      <div key={cardKey} className={`rounded-xl border border-slate-200 bg-white px-5 py-4 ${leftBorder}`}>
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                          <span className="text-base font-bold text-slate-800 tabular-nums">{fmtDate(shift.clinicDate)}</span>
                          <span className="text-xs font-bold uppercase tracking-widest text-slate-400">{shift.department.code}</span>
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
                            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                              <p className="text-sm text-amber-800 flex-1">
                                ⏳ Change requested:{" "}
                                {pendingReq.targetId
                                  ? `swap with ${pendingReq.target?.name ?? "unknown"} (${pendingReq.targetDate ? displayDate(isoDateKey(pendingReq.targetDate)) : "?"})`
                                  : "drop"}{" "}
                                — pending director review
                              </p>
                              <form action={cancelRequestAction}>
                                <input type="hidden" name="requestId" value={pendingReq.id} />
                                <ConfirmButton label="Cancel request" confirmLabel="Cancel this request?" />
                              </form>
                            </div>
                          ) : (
                            <details className="group">
                              <summary className="cursor-pointer text-xs font-medium text-slate-400 hover:text-slate-600 list-none [&::-webkit-details-marker]:hidden">
                                <span className="underline underline-offset-2">Request a change</span>
                              </summary>
                              <div className="mt-3 flex flex-col gap-4 pl-1 border-t border-slate-100 pt-3">
                                <div>
                                  <p className="text-xs font-medium text-slate-500 mb-2">Request a drop</p>
                                  <form action={createRequestAction} className="flex flex-wrap items-end gap-3">
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
                                    <p className="text-xs font-medium text-slate-500 mb-2">Request a swap</p>
                                    <form action={createRequestAction} className="flex flex-wrap items-end gap-3">
                                      <input type="hidden" name="dateKey" value={dateKey} />
                                      <input type="hidden" name="departmentId" value={shift.department.id} />
                                      <input type="hidden" name="kind" value="swap" />
                                      <div className="flex-1 min-w-56">
                                        <Select name="partner">
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
                                  <p className="text-sm text-slate-400">No eligible swap partners for this shift.</p>
                                )}
                              </div>
                            </details>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* My availability */}
            <section className="mt-10">
              <div className="flex items-center gap-3 mb-2">
                <h2 className="text-lg font-bold text-slate-800">My Availability</h2>
              </div>
              <p className="text-sm text-slate-400 mb-5">
                {availability === null
                  ? ""
                  : availability.tier === "DIRECTOR"
                  ? "Your availability is set by your director."
                  : availability.tier === "SELF"
                  ? "Based on your last update."
                  : "Based on your application responses."}
              </p>

              {availability === null ? (
                <p className="text-sm text-slate-400">You are not on the active term roster, so availability does not apply.</p>
              ) : (
                <>
                  {legacyNote && (
                    <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="mb-1 text-xs font-medium text-slate-500">Note from the old scheduler:</p>
                      <p className="text-sm text-slate-600">{legacyNote}</p>
                    </div>
                  )}
                  <form action={saveAvailabilityAction}>
                    <div className="flex flex-col gap-6">
                      {Object.entries(
                        clinicDates.reduce((acc, d) => {
                          const month = d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
                          if (!acc[month]) acc[month] = [];
                          acc[month].push(d);
                          return acc;
                        }, {} as Record<string, Date[]>)
                      ).map(([month, dates]) => (
                        <div key={month}>
                          <p className="text-xs font-semibold uppercase tracking-wide text-brand mb-2">{month}</p>
                          <div className="flex flex-wrap gap-2">
                            {dates.map((d) => {
                              const key = isoDateKey(d);
                              const checked = availability.dates.some((ad) => isoDateKey(ad) === key);
                              return (
                                <label key={key} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs cursor-pointer transition-colors whitespace-nowrap ${checked ? "border-brand bg-brand/5 text-brand font-semibold" : "border-slate-200 bg-brand/5 text-brand hover:border-brand/40"}`}>
                                  <input
                                    type="checkbox"
                                    name="dates"
                                    value={key}
                                    defaultChecked={checked}
                                    className="h-4 w-4 rounded border-slate-200 text-brand focus:ring-brand focus:ring-1 accent-brand"
                                  />
                                  {displayDate(key)}
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                    <button type="submit" className="mt-6 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-hover transition-colors">
                      Save availability
                    </button>
                  </form>
                </>
              )}
            </section>
          </div>

          {/* Right column: quick info sidebar */}
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-3">This Term</p>
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-600">Total shifts</span>
                  <span className="text-sm font-bold text-slate-800">{shifts.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-600">Role</span>
                  <span className="text-sm font-bold text-slate-800">
                    {shifts.length > 0
                      ? shifts[0].role.charAt(0) + shifts[0].role.slice(1).toLowerCase()
                      : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-600">Department</span>
                  <span className="text-sm font-bold text-slate-800">
                    {shifts.length > 0 ? shifts[0].department.code : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-600">Pending requests</span>
                  <span className="text-sm font-bold text-slate-800">{pendingRequests.size}</span>
                </div>
              </div>
            </div>


          </div>

        </div>
      )}
    </div>
  );
}