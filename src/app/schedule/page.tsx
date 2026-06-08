import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { redirect } from "next/navigation";
import {
  mySchedule,
  updateMyAvailability,
  AvailabilityValidationError,
} from "@/modules/schedule/services/schedule";
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
  searchParams: Promise<{ error?: string; saved?: string }>;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function MySchedulePage({ searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const sp = await searchParams;

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;
  const saved = sp.saved === "1";

  const { term, shifts, availability, legacyNote, clinicDates } = await mySchedule(
    session.personId
  );

  // ---------------------------------------------------------------------------
  // Server action
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
                {shifts.map((shift) => (
                  <div
                    // Unique per (date, department) for one person, per the DB constraint.
                    key={`${isoDateKey(shift.clinicDate)}-${shift.department.id}`}
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
                  </div>
                ))}
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
