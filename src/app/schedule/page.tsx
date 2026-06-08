import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
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

// ---------------------------------------------------------------------------
// Date formatting (UTC) -- consistent with other volunteer pages
// ---------------------------------------------------------------------------

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "-";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

type PageProps = {
  searchParams: Promise<{ error?: string; message?: string; saved?: string; requested?: string }>;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function MySchedulePage({ searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const sp = await searchParams;

  // Error banner: supports both the plain ?error=<msg> pattern (availability)
  // and the ?error=validation&message=<encoded> pattern (requests) copied from
  // disciplinary/page.tsx.
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

  // ---------------------------------------------------------------------------
  // Swap partner data: fetched per shift card when no pending request exists.
  // Shifts are few (1-3 per person) so one eligibleSwapPartners call per card
  // without a pending request is acceptable.
  // ---------------------------------------------------------------------------

  type SwapPartner = { personId: string; name: string; dateKey: string };

  const swapPartnersByKey = new Map<string, SwapPartner[]>();
  for (const shift of shifts) {
    const dateKey = isoDateKey(shift.clinicDate);
    const cardKey = `${dateKey}|${shift.department.id}`;
    if (!pendingRequests.has(cardKey)) {
      const partners = await eligibleSwapPartners(
        session.personId,
        dateKey,
        shift.department.id
      );
      swapPartnersByKey.set(cardKey, partners);
    }
  }

  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------

  async function saveAvailabilityAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const rawDates = formData.getAll("dates") as string[];
    // Parse day-key strings to noon-UTC Date objects so isoDateKey round-trips correctly.
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

    // Guard: a swap form submission with no partner selected is a user error.
    if (kind === "swap" && !partnerRaw) {
      redirect(
        `/schedule?error=validation&message=${encodeURIComponent("Select a swap partner before submitting.")}`
      );
    }

    let targetId: string | undefined;
    let targetDateKey: string | undefined;

    if (partnerRaw) {
      // partner value is "${personId}|${dateKey}"
      const pipeIdx = partnerRaw.indexOf("|");
      if (pipeIdx > 0) {
        targetId = partnerRaw.slice(0, pipeIdx);
        targetDateKey = partnerRaw.slice(pipeIdx + 1);
      }
    }

    try {
      await createRequest(actor.personId, {
        requesterDateKey: dateKey,
        departmentId,
        targetId,
        targetDateKey,
        note,
      });
    } catch (err) {
      if (
        err instanceof RequestValidationError ||
        err instanceof RequestForbiddenError
      ) {
        redirect(
          `/schedule?error=validation&message=${encodeURIComponent(err.message)}`
        );
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
      if (
        err instanceof RequestValidationError ||
        err instanceof RequestForbiddenError ||
        err instanceof RequestNotFoundError
      ) {
        redirect(
          `/schedule?error=validation&message=${encodeURIComponent(err.message)}`
        );
      }
      throw err;
    }
    revalidatePath("/schedule");
    redirect("/schedule");
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      <PageHeader title="My Schedule" description="Your shifts and availability for the active term" />

      {errorMessage && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-critical/20 bg-red-50 px-3 py-2 text-sm text-critical"
        >
          {errorMessage}
        </p>
      )}

      {saved && (
        <p className="mt-4 text-sm text-success">Availability saved.</p>
      )}

      {requested && (
        <p className="mt-4 text-sm text-success">Change request submitted.</p>
      )}

      {/* No active term: unified empty state */}
      {!term ? (
        <p className="mt-8 text-sm text-slate-400">No active term.</p>
      ) : (
        <>
          {/* My shifts */}
          <section className="mt-8">
            <h2 className="mb-3 text-base font-semibold">My shifts</h2>

            {shifts.length === 0 ? (
              <p className="text-sm text-slate-400">No shifts assigned yet.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {shifts.map((shift) => {
                  const dateKey = isoDateKey(shift.clinicDate);
                  const cardKey = `${dateKey}|${shift.department.id}`;
                  const pendingReq = pendingRequests.get(cardKey);
                  const swapPartners = swapPartnersByKey.get(cardKey) ?? [];

                  return (
                    <div
                      // Unique per (date, department) for one person, per the DB constraint.
                      key={cardKey}
                      className="rounded-lg border border-slate-200 bg-white px-4 py-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium tabular-nums">
                          {fmtDate(shift.clinicDate)}
                        </span>
                        <span className="text-sm text-slate-500">{shift.department.name}</span>
                        <Badge tone={shift.role === "SHADOW" ? "warning" : "default"}>
                          {shift.role === "DIRECTOR"
                            ? "Director"
                            : shift.role === "VOLUNTEER"
                            ? "Volunteer"
                            : "Shadow"}
                        </Badge>
                        {shift.tags.triage && <Badge tone="default">Triage</Badge>}
                        {shift.tags.walkin && <Badge tone="default">Walk-in</Badge>}
                        {shift.tags.cc && <Badge tone="default">CC</Badge>}
                        {shift.tags.remote && <Badge tone="default">Remote</Badge>}
                      </div>

                      {/* Request area */}
                      <div className="mt-3">
                        {pendingReq ? (
                          /* Pending request line + cancel */
                          <div className="flex flex-wrap items-center gap-3">
                            <p className="text-sm text-slate-400">
                              Change requested:{" "}
                              {pendingReq.targetId
                                ? `swap with ${pendingReq.target?.name ?? "unknown"} (${pendingReq.targetDate ? displayDate(isoDateKey(pendingReq.targetDate)) : "?"})`
                                : "drop"}{" "}
                              - pending director review
                            </p>
                            <form action={cancelRequestAction}>
                              <input type="hidden" name="requestId" value={pendingReq.id} />
                              <ConfirmButton
                                label="Cancel request"
                                confirmLabel="Cancel this request?"
                              />
                            </form>
                          </div>
                        ) : (
                          /* Request a change disclosure */
                          <details className="group">
                            <summary className="cursor-pointer text-sm text-slate-500 hover:text-slate-700 list-none [&::-webkit-details-marker]:hidden">
                              <span className="underline underline-offset-2">Request a change</span>
                            </summary>

                            <div className="mt-3 flex flex-col gap-4 pl-1">
                              {/* Drop form */}
                              <form action={createRequestAction} className="flex flex-wrap items-end gap-3">
                                <input type="hidden" name="dateKey" value={dateKey} />
                                <input type="hidden" name="departmentId" value={shift.department.id} />
                                <input type="hidden" name="kind" value="drop" />
                                <div className="flex-1 min-w-48">
                                  <Input
                                    name="note"
                                    placeholder="Optional note"
                                    aria-label="Note"
                                  />
                                </div>
                                <ConfirmButton
                                  label="Request drop"
                                  confirmLabel="Request this drop?"
                                />
                              </form>

                              {/* Swap form */}
                              {swapPartners.length === 0 ? (
                                <p className="text-sm text-slate-400">No eligible swap partners.</p>
                              ) : (
                                <form action={createRequestAction} className="flex flex-wrap items-end gap-3">
                                  <input type="hidden" name="dateKey" value={dateKey} />
                                  <input type="hidden" name="departmentId" value={shift.department.id} />
                                  <input type="hidden" name="kind" value="swap" />
                                  <div className="flex-1 min-w-56">
                                    <Select name="partner">
                                      <option value="">Select swap partner...</option>
                                      {swapPartners.map((p) => (
                                        <option
                                          key={`${p.personId}|${p.dateKey}`}
                                          value={`${p.personId}|${p.dateKey}`}
                                        >
                                          {p.name} ({displayDate(p.dateKey)})
                                        </option>
                                      ))}
                                    </Select>
                                  </div>
                                  <Button type="submit" variant="outline">
                                    Request swap
                                  </Button>
                                </form>
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
            <h2 className="mb-3 text-base font-semibold">My availability</h2>

            {availability === null ? (
              <p className="text-sm text-slate-400">
                You are not on the active term roster, so availability does not apply.
              </p>
            ) : (
              <>
                {/* Tier info */}
                <p className="mb-3 text-sm text-slate-400">
                  {availability.tier === "DIRECTOR"
                    ? "Availability set by your director."
                    : availability.tier === "SELF"
                    ? "Availability from your last update."
                    : "Availability from your application."}
                </p>

                {/* Legacy note */}
                {legacyNote && (
                  <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                    <p className="mb-1 text-xs font-medium text-slate-500">
                      Note you submitted in the old scheduler:
                    </p>
                    <p className="text-sm text-slate-600">{legacyNote}</p>
                  </div>
                )}

                <form action={saveAvailabilityAction}>
                  <div className="flex flex-col gap-2">
                    {clinicDates.map((d) => {
                      const key = isoDateKey(d);
                      const checked = availability.dates.some(
                        (ad) => isoDateKey(ad) === key
                      );
                      return (
                        <label key={key} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            name="dates"
                            value={key}
                            defaultChecked={checked}
                            className="h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand"
                          />
                          {displayDate(key)}
                        </label>
                      );
                    })}
                  </div>

                  <Button type="submit" variant="outline" className="mt-4">
                    Save availability
                  </Button>
                </form>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
