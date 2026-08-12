import Link from "next/link";
import { requireModuleAccess } from "@/platform/auth/session";
import {
  listAttendings,
  manageableServiceLines,
  attendingSchedule,
  PROCEDURE_LINE_CODE,
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
} from "@/modules/schedule/services/attendings";
import {
  upsertRhdClinic,
  parseBookedCount,
  BuilderForbiddenError,
  BuilderValidationError,
} from "@/modules/schedule/services/builder";
import { AttendingCell } from "@/modules/schedule/components/attending-cell";
import { runAction } from "@/platform/actions";
import { serviceLineDepartments } from "@/platform/departments";
import { PageHeader } from "@/platform/ui/page-header";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { buttonClasses } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { formatCalendarDate } from "@/platform/dates";

/**
 * The attending schedule, readable by every member.
 *
 * Previously manager-only, which meant the people who most need to know which
 * attending is on this Saturday (the volunteers working that shift) were the
 * ones who could not see it. Editing is still restricted, per service line.
 *
 * The procedure matrix renders only for the service line that has one
 * (reproductive health). A primary care attending has no IUD or Nexplanon
 * qualification, and showing them a grid of "unknown" would imply a gap rather
 * than an inapplicable question.
 */
type PageProps = {
  searchParams: Promise<{ message?: string }>;
};

export default async function AttendingsListPage({ searchParams }: PageProps) {
  const session = await requireModuleAccess("schedule");
  const { message } = await searchParams;

  const [lines, manageable, schedule] = await Promise.all([
    serviceLineDepartments(),
    manageableServiceLines(session.personId),
    attendingSchedule(),
  ]);
  const manageableIds = new Set(manageable.map((l) => l.id));
  const canEditAny = schedule.lines.some((l) => manageableIds.has(l.id));

  /**
   * Save one cell: one clinic date, one service line.
   *
   * Re-enforces everything rather than trusting the page that rendered the form.
   * upsertRhdClinic checks that departmentId is a real service line AND that the
   * actor manages it, so posting another line's id is rejected there, not here.
   */
  async function saveCellAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const termId = (formData.get("termId") as string) ?? "";
    const dateKey = (formData.get("dateKey") as string) ?? "";
    const departmentId = (formData.get("departmentId") as string) ?? "";
    const rawAttendingId = ((formData.get("attendingId") as string) ?? "").trim();
    const rawDirectorName = ((formData.get("directorName") as string) ?? "").trim();
    // Absent for a line that does not book procedures, which must read as "leave
    // it alone" rather than "clear it": upsertRhdClinic only writes keys present
    // in opts, so the field is omitted entirely rather than passed as null.
    const rawProcedures = formData.get("proceduresBooked");

    await runAction({
      work: () =>
        upsertRhdClinic(actor.personId, {
          termId,
          departmentId,
          dateKey,
          attendingId: rawAttendingId === "" ? null : rawAttendingId,
          directorName: rawDirectorName === "" ? null : rawDirectorName,
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

  return (
    <div className="space-y-8">
      <PageHeader
        title="Attendings"
        description={
          canEditAny
            ? "Who is covering each clinic date, by service line. Edit the lines you manage."
            : "Who is covering each clinic date, by service line."
        }
      />

      {message && <Alert tone="error">{message}</Alert>}

      {/* Schedule first: "who is on this Saturday" is what most readers came for. */}
      <section className="space-y-3">
        <SectionHeader level="title">Schedule</SectionHeader>
        {schedule.dates.length === 0 ? (
          <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
            No clinic dates in the active term yet.
          </Card>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Date</TH>
                {schedule.lines.map((l) => (
                  <TH key={l.id}>{l.code}</TH>
                ))}
              </TR>
            </THead>
            <tbody>
              {schedule.dates.map((d) => (
                <TR key={d.dateKey}>
                  <TD className="whitespace-nowrap align-top text-sm text-foreground-soft">
                    {formatCalendarDate(d.clinicDate, { month: "short", day: "numeric", year: "numeric" })}
                  </TD>
                  {schedule.lines.map((l) => (
                    <TD key={l.id} className="align-top text-sm">
                      <AttendingCell
                        cell={d.byLine[l.id]}
                        dateKey={d.dateKey}
                        line={l}
                        canEdit={manageableIds.has(l.id) && schedule.termId !== null}
                        options={schedule.optionsByLine[l.id] ?? []}
                        termId={schedule.termId ?? ""}
                        action={saveCellAction}
                      />
                    </TD>
                  ))}
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {/* Roster, one section per service line. */}
      {lines.map((line) => (
        <ServiceLineRoster key={line.id} line={line} canEdit={manageableIds.has(line.id)} />
      ))}
    </div>
  );
}

async function ServiceLineRoster({
  line,
  canEdit,
}: {
  line: { id: string; code: string; name: string };
  canEdit: boolean;
}) {
  const attendings = await listAttendings(line.id);
  const showProcedures = line.code === PROCEDURE_LINE_CODE;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeader level="title">{line.name}</SectionHeader>
        {canEdit && (
          <Link
            href={`/schedule/attendings/new?line=${line.id}`}
            className={buttonClasses("primary", "sm")}
          >
            Add attending
          </Link>
        )}
      </div>
      {attendings.length === 0 ? (
        <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
          No attendings on this roster yet.
        </Card>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              {showProcedures &&
                CAPABILITY_KEYS.map((k) => <TH key={k}>{CAPABILITY_LABELS[k]}</TH>)}
              <TH>Active</TH>
              {canEdit && <TH><span className="sr-only">Actions</span></TH>}
            </TR>
          </THead>
          <tbody>
            {attendings.map((a) => (
              <TR key={a.id}>
                <TD>
                  <span className="font-medium text-foreground">{a.scheduleName}</span>
                  <span className="block text-xs text-subtle-foreground">{a.fullName}</span>
                </TD>
                {showProcedures &&
                  CAPABILITY_KEYS.map((k) => (
                    <TD key={k} className="text-muted-foreground text-xs">{a[k] as string}</TD>
                  ))}
                <TD>
                  {a.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="default">Inactive</Badge>}
                </TD>
                {canEdit && (
                  <TD>
                    <Link href={`/schedule/attendings/${a.id}`} className="text-brand-fg hover:underline text-sm">
                      Edit
                    </Link>
                  </TD>
                )}
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
