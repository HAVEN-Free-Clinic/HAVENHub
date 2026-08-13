import Link from "next/link";
import { redirect } from "next/navigation";
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
  parseBookedCount,
  BuilderForbiddenError,
  BuilderValidationError,
} from "@/modules/schedule/services/builder";
import { AttendingCell } from "@/modules/schedule/components/attending-cell";
import { runAttendingReminders } from "@/platform/email/attending-reminders";
import { runAction } from "@/platform/actions";
import { PageHeader } from "@/platform/ui/page-header";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { buttonClasses } from "@/platform/ui/button";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { SectionHeader } from "@/platform/ui/section-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { formatCalendarDate } from "@/platform/dates";

/**
 * The attending roster and the clinic-wide attending schedule.
 *
 * Maintained by Faculty Relations (schedule.manage_attendings). Volunteers do
 * not come here: who is attending on the shift THEY work is on their own
 * schedule page, scoped to the dates they actually work.
 */
type PageProps = {
  searchParams: Promise<{ message?: string }>;
};

export default async function AttendingsPage({ searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const { message } = await searchParams;

  // Matches the nav gate in schedule/layout.tsx exactly, so the tab is never a
  // link to a page that bounces, and the URL is never a way around the tab.
  if (!(await canManageAttendings(session.personId))) redirect("/no-access");

  const [schedule, roster, specialties, capabilities] = await Promise.all([
    attendingSchedule(),
    listAttendings(),
    listSpecialties(),
    listCapabilities(),
  ]);
  const specialtyById = new Map(specialties.map((s) => [s.id, s]));

  /** Save one clinic date: its slots, on-call, specialty clinic, and day fields. */
  async function saveRowAction(formData: FormData) {
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
    const rawDirector = ((formData.get("directorName") as string) ?? "").trim();

    await runAction({
      work: () =>
        upsertClinicDay(actor.personId, {
          termId,
          dateKey,
          attendingsBySlot,
          onCallAttendingId: ((formData.get("onCallAttendingId") as string) ?? "").trim() || null,
          specialtyId: ((formData.get("specialtyId") as string) ?? "").trim() || null,
          isClosed: formData.get("isClosed") === "on",
          directorName: rawDirector || null,
          ...(rawProcedures === null
            ? {}
            : { proceduresBooked: parseBookedCount(String(rawProcedures), "Procedures booked") }),
        }),
      domainErrors: [BuilderValidationError, BuilderForbiddenError],
      errorRedirect: (m) => `/schedule/attendings?message=${encodeURIComponent(m)}`,
      revalidate: "/schedule/attendings",
      successRedirect: "/schedule/attendings",
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
      errorRedirect: (m) => `/schedule/attendings?message=${encodeURIComponent(m)}`,
      revalidate: "/schedule/attendings",
      successRedirect: "/schedule/attendings?message=Reminders+sent.",
    });
  }

  const specialtyClinicOptions = specialties.filter((s) => s.runsSpecialtyClinic);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Attendings"
        description="The clinic's attending roster and who is covering each clinic date."
      />

      {message && <Alert tone="error">{message}</Alert>}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeader level="title">Schedule</SectionHeader>
          <form action={sendRemindersAction}>
            <Button type="submit" variant="outline" size="sm">
              Send this week&rsquo;s reminder
            </Button>
          </form>
        </div>
        <p className="text-xs text-muted-foreground">
          The attending reminder goes out automatically on Monday mornings. Send it again here if
          the schedule changed after it went out; anyone already reminded this week is skipped.
        </p>
        {schedule.rows.length === 0 ? (
          <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
            {schedule.emptyReason === "no-active-term" ? (
              "No active term. Activate one in Admin > Terms to schedule attendings."
            ) : schedule.emptyReason === "no-clinic-dates" ? (
              "The active term has no clinic dates yet. Add them in Admin > Terms."
            ) : (
              "No schedule columns are defined yet, so there is nowhere to put an attending."
            )}
          </Card>
        ) : (
          /* One card per clinic date, each its own form.
           *
           * Deliberately NOT a table row per date. A <form> cannot legally wrap
           * <td>s, so a table forces the controls outside the form and
           * associated by `form=` id -- and a server action serialises only the
           * form's DESCENDANTS, so every one of those controls is silently
           * dropped on submit. The day row saved and its attendings did not.
           */
          <div className="space-y-3">
            {schedule.rows.map((row) => (
              <Card key={row.dateKey} className="space-y-3">
                <form action={saveRowAction} className="space-y-3">
                  <input type="hidden" name="termId" value={schedule.termId ?? ""} />
                  <input type="hidden" name="dateKey" value={row.dateKey} />

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-base font-bold text-foreground tabular-nums">
                      {formatCalendarDate(row.clinicDate, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </h3>
                    <label className="flex items-center gap-2 text-sm text-foreground-soft">
                      <Checkbox name="isClosed" defaultChecked={row.isClosed} />
                      Clinic closed
                    </label>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {schedule.slots.map((slot) => (
                      <div key={slot.id} className="space-y-1">
                        <span className="block text-xs font-medium text-foreground-soft">
                          {slot.label}
                          <span className="ml-1 font-normal text-subtle-foreground">
                            {slot.startTime}-{slot.endTime}
                          </span>
                        </span>
                        <AttendingCell
                          slot={slot}
                          coverage={row.slots.find((c) => c.slotId === slot.id)}
                          dateKey={row.dateKey}
                          canEdit
                          isClosed={row.isClosed}
                          options={schedule.options}
                        />
                      </div>
                    ))}

                    <div className="space-y-1">
                      {/* On call covers the week LEADING UP TO the next clinic
                          day, which is why it sits on this date but is not one
                          of the day's slots. */}
                      <span className="block text-xs font-medium text-foreground-soft">
                        On call
                        <span className="ml-1 font-normal text-subtle-foreground">next week</span>
                      </span>
                      <Select
                        name="onCallAttendingId"
                        defaultValue={row.onCallAttendingId ?? ""}
                        aria-label={`On-call attending for the week after ${row.dateKey}`}
                        className="text-sm"
                      >
                        <option value="">Not set</option>
                        {schedule.options.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.isActive ? a.scheduleName : `${a.scheduleName} (inactive)`}
                          </option>
                        ))}
                      </Select>
                    </div>

                    <div className="space-y-1">
                      <span className="block text-xs font-medium text-foreground-soft">
                        Specialty clinic
                      </span>
                      <Select
                        name="specialtyId"
                        defaultValue={row.specialtyId ?? ""}
                        aria-label={`Specialty clinic on ${row.dateKey}`}
                        className="text-sm"
                      >
                        <option value="">None</option>
                        {specialtyClinicOptions.map((sp) => (
                          <option key={sp.id} value={sp.id}>{sp.name}</option>
                        ))}
                      </Select>
                    </div>

                    <div className="space-y-1">
                      <span className="block text-xs font-medium text-foreground-soft">
                        Director on point
                      </span>
                      <Input
                        name="directorName"
                        defaultValue={row.directorName ?? ""}
                        placeholder="Optional"
                        aria-label={`Director on point for ${row.dateKey}`}
                        className="text-sm"
                      />
                    </div>

                    <div className="space-y-1">
                      <span className="block text-xs font-medium text-foreground-soft">
                        Procedures booked
                      </span>
                      <Input
                        name="proceduresBooked"
                        type="number"
                        min={0}
                        defaultValue={row.proceduresBooked ?? ""}
                        placeholder="Optional"
                        aria-label={`Procedures booked for ${row.dateKey}`}
                        className="text-sm"
                      />
                    </div>
                  </div>

                  <FormActions>
                    <Button type="submit" variant="outline" size="sm">Save</Button>
                  </FormActions>
                </form>
              </Card>
            ))}
          </div>
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
