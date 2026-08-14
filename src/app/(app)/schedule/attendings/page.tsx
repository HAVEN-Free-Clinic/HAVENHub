import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/platform/db";
import { requireModuleAccess } from "@/platform/auth/session";
import {
  listAttendings,
  listSpecialties,
  listCapabilities,
  canManageAttendings,
  attendingSchedule,
} from "@/modules/schedule/services/attendings";
import {
  upsertClinicDay,
  setSlotAttending,
  parseBookedCount,
  BuilderForbiddenError,
  BuilderValidationError,
} from "@/modules/schedule/services/builder";
import { AttendingGrid } from "@/modules/schedule/components/attending-grid";
import { AttendingDayView } from "@/modules/schedule/components/attending-day-view";
import {
  AttendingToolbar,
  attendingViewHref,
  ON_CALL_TARGET,
  type AttendingView,
} from "@/modules/schedule/components/attending-toolbar";
import { ClinicDateStrip } from "@/modules/schedule/components/clinic-date-strip";
import { runAttendingReminders } from "@/platform/email/attending-reminders";
import { runAction } from "@/platform/actions";
import { getWorkingTerm } from "@/platform/terms/working-term";
import { getActiveTerm } from "@/platform/terms/active-term";
import { buildTermOptions } from "@/platform/terms/term-options";
import { displayTodayKey } from "@/platform/dates/today";
import { PageHeader } from "@/platform/ui/page-header";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { buttonClasses } from "@/platform/ui/button";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";

/**
 * The attending roster and the clinic-wide attending schedule builder.
 *
 * Maintained by Faculty Relations (schedule.manage_attendings). Volunteers do
 * not come here: who is attending on the shift THEY work is on their own
 * schedule page, scoped to their department. Everyone running a clinic day
 * reads the whole grid on /schedule/coverage, which has no controls.
 */
const BASE = "/schedule/attendings";

type PageProps = {
  searchParams: Promise<{
    message?: string;
    view?: string;
    date?: string;
    target?: string;
    term?: string;
  }>;
};

export default async function AttendingsPage({ searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const sp = await searchParams;

  // Matches the nav gate in schedule/layout.tsx exactly, so the tab is never a
  // link to a page that bounces, and the URL is never a way around the tab.
  if (!(await canManageAttendings(session.personId))) redirect("/no-access");

  const view: AttendingView = sp.view === "day" ? "day" : "grid";

  const [workingTermOrNull, liveTerm] = await Promise.all([getWorkingTerm(sp.term), getActiveTerm()]);
  if (!workingTermOrNull) {
    return (
      <div className="space-y-8">
        <PageHeader title="Attendings" description="No active term" />
        <p className="text-sm text-muted-foreground">
          There is no term to schedule attendings for yet. Activate one in Admin &gt; Terms.
        </p>
      </div>
    );
  }
  // Reassigned rather than used narrowed, so the non-null type carries into the
  // "use server" closures below: TS does not retain control-flow narrowing of an
  // outer const across a nested function boundary.
  const workingTerm = workingTermOrNull;
  const termParam = workingTerm.id === liveTerm?.id ? undefined : workingTerm.id; // omit ?term for the live term

  const [schedule, roster, specialties, capabilities, todayKey] = await Promise.all([
    attendingSchedule(workingTerm.id),
    listAttendings(),
    listSpecialties(),
    listCapabilities(),
    displayTodayKey(),
  ]);
  const specialtyById = new Map(specialties.map((s) => [s.id, s]));

  // Wayfinding cue: the clinic date being worked toward. Skips the Saturdays the
  // term does not run -- the rows span the whole term now, so "the next row" is
  // often a break week, which is not what anyone is working toward. Null when
  // every clinic date has passed, rather than pinning the last one.
  const openRows = schedule.rows.filter((r) => r.isClinicDate && !r.storedClosed);
  const highlightDateKey = openRows.find((r) => r.dateKey >= todayKey)?.dateKey ?? null;

  // The Day view opens on a date worth editing. An explicit ?date wins, so a
  // break week is still reachable to set its on-call attending.
  const selectedDateKey =
    schedule.rows.find((r) => r.dateKey === sp.date)?.dateKey ??
    highlightDateKey ??
    openRows[0]?.dateKey ??
    schedule.rows[0]?.dateKey ??
    null;

  // The grid's assign target. Defaults to the first column rather than on call:
  // filling columns is the common job, and on call is one cell a week.
  const target =
    sp.target === ON_CALL_TARGET
      ? ON_CALL_TARGET
      : (schedule.slots.find((s) => s.id === sp.target)?.id ?? schedule.slots[0]?.id ?? ON_CALL_TARGET);

  const hrefParams = { date: selectedDateKey, term: termParam ?? null, target };
  const selfHref = attendingViewHref(BASE, hrefParams, view);

  /** Where an action returns to, so a save does not drop the view being worked in. */
  function backHref(message?: string): string {
    const sep = selfHref.includes("?") ? "&" : "?";
    return message ? `${selfHref}${sep}message=${encodeURIComponent(message)}` : selfHref;
  }

  /** Save one clinic date: its slots, on-call, specialty clinic, and day fields. */
  async function saveDayAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const termId = (formData.get("termId") as string) ?? "";
    const dateKey = (formData.get("dateKey") as string) ?? "";

    // One `slot:<id>` field per select the row rendered; a multi-slot posts
    // several. Empty values are dropped, so clearing a select unstaffs it.
    const attendingsBySlot: Record<string, string[]> = {};
    for (const [name, value] of formData.entries()) {
      if (!name.startsWith("slot:")) continue;
      const slotId = name.slice("slot:".length);
      const id = String(value).trim();
      attendingsBySlot[slotId] ??= [];
      if (id) attendingsBySlot[slotId].push(id);
    }

    const rawProcedures = formData.get("proceduresBooked");
    const rawDirector = formData.get("directorName");

    await runAction({
      work: () =>
        upsertClinicDay(actor.personId, {
          termId,
          dateKey,
          // Only what the form actually rendered is sent. A closed or non-clinic
          // date renders no clinical controls, and posting them as empty would
          // read as "clear them" -- wiping a specialty clinic that was set
          // before the date was closed.
          ...(Object.keys(attendingsBySlot).length > 0 ? { attendingsBySlot } : {}),
          onCallAttendingId: ((formData.get("onCallAttendingId") as string) ?? "").trim() || null,
          ...(formData.has("specialtyId")
            ? { specialtyId: ((formData.get("specialtyId") as string) ?? "").trim() || null }
            : {}),
          ...(formData.has("isClosed") || formData.has("closedMarker")
            ? { isClosed: formData.get("isClosed") === "on" }
            : {}),
          ...(rawDirector === null ? {} : { directorName: String(rawDirector).trim() || null }),
          ...(rawProcedures === null
            ? {}
            : { proceduresBooked: parseBookedCount(String(rawProcedures), "Procedures booked") }),
        }),
      domainErrors: [BuilderValidationError, BuilderForbiddenError],
      errorRedirect: (m) => backHref(m),
      revalidate: BASE,
      successRedirect: backHref(),
    });
  }

  /** Grid cell: put one attending in one column on one date. */
  async function assignAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    await runAction({
      work: () =>
        setSlotAttending(actor.personId, {
          termId: (formData.get("termId") as string) ?? "",
          dateKey: (formData.get("dateKey") as string) ?? "",
          slotId: (formData.get("slotId") as string) ?? "",
          attendingId: (formData.get("attendingId") as string) ?? "",
          assigned: true,
        }),
      domainErrors: [BuilderValidationError, BuilderForbiddenError],
      errorRedirect: (m) => backHref(m),
      revalidate: BASE,
      successRedirect: backHref(),
    });
  }

  /** Grid cell: take one attending out of one column on one date. */
  async function unassignAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    await runAction({
      work: () =>
        setSlotAttending(actor.personId, {
          termId: (formData.get("termId") as string) ?? "",
          dateKey: (formData.get("dateKey") as string) ?? "",
          slotId: (formData.get("slotId") as string) ?? "",
          attendingId: (formData.get("attendingId") as string) ?? "",
          assigned: false,
        }),
      domainErrors: [BuilderValidationError, BuilderForbiddenError],
      errorRedirect: (m) => backHref(m),
      revalidate: BASE,
      successRedirect: backHref(),
    });
  }

  /**
   * Grid cell: hand the week's on-call pager to one attending, or clear it.
   *
   * The one write that works on a closed or non-clinic date, because on call
   * covers the week leading up to the NEXT clinic day.
   */
  async function setOnCallAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    await runAction({
      work: () =>
        upsertClinicDay(actor.personId, {
          termId: (formData.get("termId") as string) ?? "",
          dateKey: (formData.get("dateKey") as string) ?? "",
          onCallAttendingId: ((formData.get("attendingId") as string) ?? "").trim() || null,
        }),
      domainErrors: [BuilderValidationError, BuilderForbiddenError],
      errorRedirect: (m) => backHref(m),
      revalidate: BASE,
      successRedirect: backHref(),
    });
  }

  /**
   * Send this week's attending reminder now.
   *
   * The Monday cron sends it automatically; this is for the week the schedule
   * changed after it went out, or the first week after a term flips. Safe to
   * press twice: the runner skips anyone already reminded for this clinic date.
   */
  async function sendRemindersAction() {
    "use server";
    const actor = await requireModuleAccess("schedule");
    await runAction({
      work: async () => {
        if (!(await canManageAttendings(actor.personId))) {
          throw new BuilderForbiddenError("You do not manage the attending schedule.");
        }
        const r = await runAttendingReminders();
        if (r.remindersSent === 0) {
          const why =
            r.skippedAlreadySent > 0
              ? `already sent to ${r.skippedAlreadySent} attending(s) this week`
              : "nothing scheduled for the upcoming clinic date, or it is closed";
          throw new BuilderValidationError(`No reminders sent: ${why}.`);
        }
      },
      domainErrors: [BuilderValidationError, BuilderForbiddenError],
      errorRedirect: (m) => backHref(m),
      revalidate: BASE,
      successRedirect: backHref("Reminders sent."),
    });
  }

  const switcherTerms = await prisma.term.findMany({
    orderBy: { startDate: "desc" },
    take: 8, // live + next + a bounded set of recent archived
    select: { id: true, code: true, status: true },
  });
  const termOptions = buildTermOptions(switcherTerms, { includeArchived: true });

  const selectedRow = schedule.rows.find((r) => r.dateKey === selectedDateKey) ?? null;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Attendings"
        description={`The clinic's attending roster and who is covering each date · ${workingTerm.name}`}
      />

      {sp.message && <Alert tone="error">{sp.message}</Alert>}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeader level="title">Schedule</SectionHeader>
          <div className="flex items-center gap-2">
            <Link href="/schedule/coverage" className={buttonClasses("outline", "sm")}>
              Coverage viewer
            </Link>
            <form action={sendRemindersAction}>
              <Button type="submit" variant="outline" size="sm">
                Send this week&rsquo;s reminder
              </Button>
            </form>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The attending reminder goes out automatically on Monday mornings. Send it again here if
          the schedule changed after it went out; anyone already reminded this week is skipped.
        </p>

        {schedule.rows.length === 0 ? (
          <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
            {schedule.emptyReason === "no-clinic-dates"
              ? `${workingTerm.name} has no clinic dates yet. Add them in Admin > Terms.`
              : "No schedule columns are defined yet, so there is nowhere to put an attending."}
          </Card>
        ) : (
          <>
            <AttendingToolbar
              base={BASE}
              view={view}
              hrefParams={hrefParams}
              slots={schedule.slots}
              target={target}
              termOptions={termOptions}
              workingTermId={workingTerm.id}
              liveTermId={liveTerm?.id ?? null}
              hrefForTerm={(termId) =>
                attendingViewHref(BASE, { ...hrefParams, term: termId }, view)
              }
            />

            {!schedule.editable && (
              <Alert tone="info">
                {workingTerm.name} is archived, so its attending schedule is read only.
              </Alert>
            )}

            {view === "grid" ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  {target === ON_CALL_TARGET
                    ? "Clicking a cell hands that week's on-call pager to the attending. A date holds one on-call attending, so clicking a new cell moves it. On call is settable on closed dates: it covers the week leading up to the next clinic day."
                    : `Clicking a cell assigns the attending to ${
                        schedule.slots.find((s) => s.id === target)?.label ?? "the selected column"
                      } on that date. Switch the column above to fill another one; a cell already filled in a different column shows its short name.`}
                </p>
                <AttendingGrid
                  rows={schedule.rows}
                  slots={schedule.slots}
                  options={schedule.options}
                  termId={workingTerm.id}
                  mode={target === ON_CALL_TARGET ? { kind: "oncall" } : { kind: "slot", slotId: target }}
                  editable={schedule.editable}
                  highlightDateKey={highlightDateKey}
                  assignAction={assignAction}
                  unassignAction={unassignAction}
                  setOnCallAction={setOnCallAction}
                />
              </div>
            ) : (
              <div className="space-y-4">
                <ClinicDateStrip
                  dates={schedule.rows.map((r) => r.clinicDate)}
                  selectedKey={selectedDateKey}
                  hrefFor={(key) => attendingViewHref(BASE, { ...hrefParams, date: key }, "day")}
                  ariaLabel="Clinic dates"
                />
                {selectedRow && (
                  <AttendingDayView
                    row={selectedRow}
                    slots={schedule.slots}
                    specialties={schedule.specialties}
                    options={schedule.options}
                    termId={workingTerm.id}
                    termName={workingTerm.name}
                    editable={schedule.editable}
                    saveAction={saveDayAction}
                  />
                )}
              </div>
            )}
          </>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeader level="title">Roster</SectionHeader>
          <div className="flex items-center gap-2">
            <Link
              href="/schedule/attendings/credentialing"
              className={buttonClasses("outline", "sm")}
            >
              Credentialing
            </Link>
            <Link href="/schedule/attendings/new" className={buttonClasses("primary", "sm")}>
              Add attending
            </Link>
          </div>
        </div>
        {roster.length === 0 ? (
          <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
            No attendings on the roster yet.
          </Card>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Specialty</TH>
                  <TH>Contact</TH>
                  {capabilities.map((c) => <TH key={c.id}>{c.label}</TH>)}
                  <TH>Active</TH>
                  <TH><span className="sr-only">Actions</span></TH>
                </TR>
              </THead>
              <tbody>
                {roster.map((a) => (
                  <TR key={a.id}>
                    <TD>
                      <span className="font-medium text-foreground">{a.scheduleName}</span>
                      <span className="block text-xs text-subtle-foreground">
                        {a.fullName}
                        {a.credentials ? `, ${a.credentials}` : ""}
                      </span>
                    </TD>
                    <TD className="text-sm text-muted-foreground">
                      {a.specialtyId ? specialtyById.get(a.specialtyId)?.name ?? "" : "Not set"}
                    </TD>
                    <TD className="text-xs text-muted-foreground">
                      {a.email && <span className="block">{a.email}</span>}
                      {a.phone && <span className="block">{a.phone}</span>}
                    </TD>
                    {capabilities.map((c) => (
                      <TD key={c.id} className="text-xs text-muted-foreground">
                        {/* Blank, not "unknown", when the question is not asked
                            of this attending's specialty: a dermatologist has no
                            IUD answer to give. */}
                        {c.specialtyId && c.specialtyId !== a.specialtyId
                          ? ""
                          : a.capabilityValues[c.id] ?? "unknown"}
                      </TD>
                    ))}
                    <TD>
                      {a.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="default">Inactive</Badge>}
                    </TD>
                    <TD>
                      <Link href={`/schedule/attendings/${a.id}`} className="text-brand-fg hover:underline text-sm">
                        Edit
                      </Link>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
