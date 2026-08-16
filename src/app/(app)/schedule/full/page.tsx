import { requireModuleAccess, requirePermission } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { revalidatePath } from "next/cache";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { cardClasses } from "@/platform/ui/card";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { fullSchedule } from "@/modules/schedule/services/schedule";
import { markPresent, undoAttendance } from "@/modules/schedule/services/attendance";
import { displayTodayKey } from "@/platform/dates/today";
import { isSelectedDateToday } from "@/modules/schedule/engine/attendance-window";
import { isoDateKey } from "@/modules/schedule/engine/map";
import { ClinicDateStrip } from "@/modules/schedule/components/clinic-date-strip";
import { formatCalendarDate } from "@/platform/dates";
import { languageLabel } from "@/platform/languages";
import { loadClearedSet } from "@/platform/clearance";
import { PersonName } from "@/platform/ui/person-name";

type PageProps = {
  searchParams: Promise<{ date?: string; [key: string]: string | string[] | undefined }>;
};

export default async function FullSchedulePage({ searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const sp = await searchParams;

  // Attendance overlay is a separate, narrower permission from ordinary
  // schedule.view access. Members without it must see this page exactly as it
  // is today: no column, no badges, no indication of who has or hasn't checked
  // in. Only holders of schedule.manage_attendance see attendance state at all.
  const canMarkAttendance = await can(session.personId, "schedule.manage_attendance");

  const { term, clinicDates, selectedDate, departments, attendance } = await fullSchedule(sp.date);
  const selectedKey = selectedDate ? isoDateKey(selectedDate) : null;

  // Verified badges, resolved ONCE for every person on the page rather than per
  // name: loadClearedSet fans out to roughly a dozen queries, and this page
  // renders every assignment across every department for a clinic date.
  //
  // Gated on volunteers.view, the same permission that opens the compliance
  // roster where clearance is already visible. A plain volunteer browsing the
  // schedule sees no badges and pays no query cost, because the call is skipped
  // entirely rather than computed and hidden.
  const canSeeClearance = await can(session.personId, "volunteers.view");
  const scheduledPersonIds = canSeeClearance
    ? departments.flatMap((d) =>
        [...d.directors, ...d.volunteers, ...d.shadows].map((p) => p.id)
      )
    : [];
  const clearedIds = await loadClearedSet(scheduledPersonIds);

  // markPresent/undoAttendance both write against TODAY's clinic date
  // (todaysClinicDate inside attendance.ts), not whatever date this page
  // happens to have selected. The date strip lets a director browse to any
  // clinic date in the term, so without this check a write triggered from a
  // non-today row would either no-op (today isn't a clinic day) or, worse,
  // silently land on TODAY's attendance instead of the browsed date's. Only
  // offer the write controls when the selected date IS the live clinic day;
  // other dates show attendance read-only. See isSelectedDateToday for the
  // (separately unit-tested) comparison itself.
  const todayKey = await displayTodayKey();
  const selectedDateIsToday = isSelectedDateToday(selectedKey, todayKey);

  // Each action re-enforces schedule.manage_attendance itself: a server action
  // is a public endpoint in its own right, and this page's gate above does not
  // protect it from being invoked directly.
  async function markPresentAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("schedule.manage_attendance");
    const personId = (formData.get("personId") as string | null) ?? "";
    if (personId) await markPresent(actor.personId, personId);
    revalidatePath("/schedule/full");
  }

  async function undoAttendanceAction(formData: FormData) {
    "use server";
    await requirePermission("schedule.manage_attendance");
    const personId = (formData.get("personId") as string | null) ?? "";
    if (personId) await undoAttendance(personId);
    revalidatePath("/schedule/full");
  }

  /**
   * Attendance control for one roster row, gated on canMarkAttendance so a
   * member without the permission never renders anything here -- not a badge,
   * not a button, not an absence indicator. Holders see a "Here" badge when a
   * record exists for whatever date is selected (read-only, safe to show for
   * any date). The write controls (undo, mark present) only render on the
   * live clinic day, since that is the only date the underlying service
   * functions actually write against.
   */
  function attendanceControl(personId: string) {
    if (!canMarkAttendance) return null;
    const record = attendance.get(personId);
    if (record) {
      return (
        <span className="flex items-center gap-1.5">
          <Badge tone="success">Here</Badge>
          {selectedDateIsToday && (
            <form action={undoAttendanceAction}>
              <input type="hidden" name="personId" value={personId} />
              <Button type="submit" variant="ghost" className="px-2 py-0.5 text-xs">
                Undo
              </Button>
            </form>
          )}
        </span>
      );
    }
    if (!selectedDateIsToday) return null;
    return (
      <form action={markPresentAction}>
        <input type="hidden" name="personId" value={personId} />
        <Button type="submit" variant="outline" className="px-2 py-0.5 text-xs">
          Mark present
        </Button>
      </form>
    );
  }

  const selectedDisplay = selectedDate
    ? formatCalendarDate(selectedDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    : null;

  /**
   * Shift flag badges for one roster row. Rendered for EVERY role, not just
   * volunteers: the clinic needs to see which DIRECTOR is on triage or working
   * remotely, and that is exactly what the full schedule is consulted for.
   */
  function shiftTags(tags: { triage: boolean; walkin: boolean; cc: boolean; remote: boolean }) {
    return (
      <>
        {tags.triage && <Badge tone="default">Triage</Badge>}
        {tags.walkin && <Badge tone="default">Walk-in</Badge>}
        {tags.cc && <Badge tone="default">CC</Badge>}
        {tags.remote && <Badge tone="default">Remote</Badge>}
      </>
    );
  }

  /**
   * Person-level capability badges: verified languages and RN.
   *
   * Distinct from the shift tags above, which describe the ASSIGNMENT (this
   * person is on triage today). These describe the PERSON and are the same on
   * every date. Both belong on this page because it is where the clinic looks
   * someone up mid-shift, and "who can interpret for this patient" is the
   * question it most often has to answer.
   *
   * Verified only, by construction: fullSchedule never returns a self-reported
   * claim here.
   */
  function capabilityBadges(person: { verifiedLanguages: string[]; licensedRN: boolean }) {
    return (
      <>
        {/* Code, not the full name: these rows already carry up to four shift
            tags plus a conflict badge, and "Haitian Creole" would wrap every
            row that has one. The full name is on the title for anyone who does
            not recognise the code. */}
        {person.verifiedLanguages.map((code) => (
          <Badge key={code} tone="brand" title={`Verified: ${languageLabel(code)}`}>
            {code.toUpperCase()}
          </Badge>
        ))}
        {person.licensedRN && <Badge tone="brand">RN</Badge>}
      </>
    );
  }

  const totalVolunteers = departments.reduce((acc, d) => acc + d.volunteers.length, 0);
  const totalDirectors = departments.reduce((acc, d) => acc + d.directors.length, 0);
  const totalShadows = departments.reduce((acc, d) => acc + d.shadows.length, 0);

  return (
    <div>
      <div className="mb-8">
        <PageHeader
          title="Full Schedule"
          description={
            term
              ? `${term.name}${
                  selectedDate && departments.length > 0
                    ? ` · ${totalDirectors} director${totalDirectors !== 1 ? "s" : ""}, ${totalVolunteers} volunteer${
                        totalVolunteers !== 1 ? "s" : ""
                      }, ${totalShadows} shadow${totalShadows !== 1 ? "s" : ""} across ${departments.length} department${
                        departments.length !== 1 ? "s" : ""
                      }`
                    : ""
                }`
              : undefined
          }
        />
      </div>

      {!term ? (
        <p className="text-sm text-subtle-foreground">No active term.</p>
      ) : (
        <>
          {/* Date strip */}
          <div className="mb-8">
            <ClinicDateStrip
              dates={clinicDates}
              selectedKey={selectedKey}
              hrefFor={(key) => `/schedule/full?date=${key}`}
              ariaLabel="Schedule dates"
            />
          </div>

          {selectedDisplay && <SectionHeader level="title" className="mb-4">{selectedDisplay}</SectionHeader>}

          {/* Department cards */}
          {departments.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-subtle-foreground">
              Nothing scheduled for this date.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {departments.map(({ department, directors, volunteers, shadows, conflicts }) => (
                <section
                  key={department.id}
                  className={`${cardClasses({ pad: false })} overflow-hidden`}
                >
                  {/* Card header. Neutral surface, not bg-brand: the brand colour means
                      "selected" everywhere else in this module, and a grid of brand-capped
                      cards spends it on decoration. */}
                  <div className="border-b border-border bg-muted px-4 py-3 flex flex-wrap items-center justify-between gap-2">
                    <SectionHeader as="h3" level="title" className="min-w-0 truncate">
                      {department.name}
                    </SectionHeader>
                    <div className="flex items-center gap-1.5">
                      <Badge>{department.code}</Badge>
                      {directors.length > 0 && <Badge tone="brand">{directors.length} director{directors.length === 1 ? "" : "s"}</Badge>}
                      {volunteers.length > 0 && <Badge tone="success">{volunteers.length} volunteer{volunteers.length === 1 ? "" : "s"}</Badge>}
                      {shadows.length > 0 && <Badge tone="warning">{shadows.length} shadow{shadows.length === 1 ? "" : "s"}</Badge>}
                    </div>
                  </div>

                  {/* Card body */}
                  <div className="px-4 py-4 flex flex-col gap-4">

                    {/* Directors */}
                    {directors.length > 0 && (
                      <div>
                        <SectionHeader as="h4" className="mb-1.5">Directors</SectionHeader>
                        <ul className="flex flex-col gap-1">
                          {directors.map((p) => (
                            <li key={p.id} className="flex flex-wrap items-center gap-1.5">
                              <PersonName name={p.name} cleared={clearedIds.has(p.id)} className="text-sm font-bold text-foreground" />
                              {shiftTags(p.tags)}
                              {capabilityBadges(p)}
                              {(conflicts.get(p.id) ?? []).length > 0 && (
                                <Badge tone="warning" title={(conflicts.get(p.id) ?? []).join(", ")}>
                                  Also in {(conflicts.get(p.id) ?? []).join(", ")}
                                </Badge>
                              )}
                              {attendanceControl(p.id)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Volunteers */}
                    {volunteers.length > 0 && (
                      <div>
                        <SectionHeader as="h4" className="mb-1.5">Volunteers</SectionHeader>
                        <ul className="flex flex-col gap-1">
                          {volunteers.map((v) => (
                            <li key={v.id} className="flex flex-wrap items-center gap-1.5">
                              <PersonName name={v.name} cleared={clearedIds.has(v.id)} className="text-sm text-foreground-soft" />
                              {shiftTags(v.tags)}
                              {capabilityBadges(v)}
                              {(conflicts.get(v.id) ?? []).length > 0 && (
                                <Badge tone="warning" title={(conflicts.get(v.id) ?? []).join(", ")}>
                                  Also in {(conflicts.get(v.id) ?? []).join(", ")}
                                </Badge>
                              )}
                              {attendanceControl(v.id)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Shadows */}
                    {shadows.length > 0 && (
                      <div>
                        <SectionHeader as="h4" className="mb-1.5">Shadows</SectionHeader>
                        <ul className="flex flex-col gap-1">
                          {shadows.map((p) => (
                            <li key={p.id} className="flex flex-wrap items-center gap-1.5">
                              <PersonName name={p.name} cleared={clearedIds.has(p.id)} className="text-sm text-subtle-foreground italic" />
                              {shiftTags(p.tags)}
                              {capabilityBadges(p)}
                              {(conflicts.get(p.id) ?? []).length > 0 && (
                                <Badge tone="warning" title={(conflicts.get(p.id) ?? []).join(", ")}>
                                  Also in {(conflicts.get(p.id) ?? []).join(", ")}
                                </Badge>
                              )}
                              {attendanceControl(p.id)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {directors.length === 0 && volunteers.length === 0 && shadows.length === 0 && (
                      <p className="text-sm text-subtle-foreground italic">Nothing scheduled</p>
                    )}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}