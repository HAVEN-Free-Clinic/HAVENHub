import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getWorkingTerm } from "@/platform/terms/working-term";
import { buildTermOptions } from "@/platform/terms/term-options";
import {
  createMeeting,
  listMeetings,
  unexcusedAbsenceCounts,
  BoardAttendanceValidationError,
  BoardAttendanceForbiddenError,
} from "@/modules/volunteers/services/board-attendance";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Field, Input } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { FormActions } from "@/platform/ui/form";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { TermSwitcher } from "@/platform/ui/term-switcher";
import { formatCalendarDate } from "@/platform/dates";

const BASE = "/volunteers/board-meetings";

type PageProps = {
  searchParams: Promise<{ error?: string; term?: string }>;
};

/**
 * Board meeting attendance.
 *
 * The unexcused-absence panel exists because the director contract makes two
 * unexcused absences worth one strike. It surfaces the count and stops: raising
 * the strike remains a deliberate act in the incidents module.
 *
 * The term switcher is how the imported history is read (see
 * platform/board-attendance/import). Past terms are browsable but cannot gain
 * new meetings: creating one always targets the live term, so a mistyped date
 * cannot quietly land a 2026 meeting in the 2024 record.
 */
export default async function BoardMeetingsPage({ searchParams }: PageProps) {
  await requirePermission("volunteers.manage_board_attendance");
  const sp = await searchParams;
  const [term, liveTerm] = await Promise.all([getWorkingTerm(sp.term), getActiveTerm()]);

  if (!term) {
    return (
      <div className="space-y-6">
        <PageHeader title="Board meetings" />
        <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
          No active term, so there is no director roster to record attendance against.
        </Card>
      </div>
    );
  }

  const isLiveTerm = term.id === liveTerm?.id;

  const [meetings, absences, switcherTerms] = await Promise.all([
    listMeetings(term.id),
    unexcusedAbsenceCounts(term.id),
    // Only terms that actually hold meetings, plus the live one so there is
    // always somewhere to add today's. Listing every term would fill the
    // switcher with archived terms that have nothing behind them.
    prisma.term.findMany({
      where: {
        OR: [{ boardMeetings: { some: {} } }, ...(liveTerm ? [{ id: liveTerm.id }] : [])],
      },
      orderBy: { startDate: "desc" },
      select: { id: true, code: true, status: true },
    }),
  ]);

  // Names for the absence panel. Only people who actually have an absence, so
  // this stays small however large the roster is.
  const flagged = [...absences.entries()].filter(([, n]) => n > 0);
  const people =
    flagged.length === 0
      ? []
      : await prisma.person.findMany({
          where: { id: { in: flagged.map(([id]) => id) } },
          select: { id: true, name: true },
        });
  const nameById = new Map(people.map((p) => [p.id, p.name]));

  const hrefForTerm = (termId: string | null) =>
    termId && termId !== liveTerm?.id ? `${BASE}?term=${termId}` : BASE;

  async function createAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.manage_board_attendance");
    const activeTerm = await getActiveTerm();
    if (!activeTerm) redirect(BASE);
    try {
      await createMeeting(actor.personId, {
        termId: activeTerm.id,
        dateKey: String(formData.get("meetingDate") ?? ""),
        title: String(formData.get("title") ?? ""),
      });
    } catch (err) {
      if (err instanceof BoardAttendanceValidationError || err instanceof BoardAttendanceForbiddenError) {
        redirect(`${BASE}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(BASE);
  }

  return (
    <div className="space-y-8">
      <PageHeader title="Board meetings" description={term.name} />

      {switcherTerms.length > 1 && (
        <div className="rounded-2xl border border-border bg-muted px-4 py-3">
          <TermSwitcher
            options={buildTermOptions(switcherTerms, { includeArchived: true })}
            selectedId={term.id}
            liveTermId={liveTerm?.id ?? null}
            hrefForTerm={hrefForTerm}
          />
        </div>
      )}

      {sp.error && <Alert tone="error">{sp.error}</Alert>}

      {isLiveTerm && (
        <section className="space-y-3">
          <SectionHeader level="title">Add a meeting</SectionHeader>
          <Card>
            <form action={createAction} className="flex flex-wrap items-end gap-3">
              <div className="w-48">
                <Field label="Date" required>
                  <Input type="date" name="meetingDate" required />
                </Field>
              </div>
              <div className="min-w-[12rem] flex-1">
                <Field label="Title" hint="Optional.">
                  <Input name="title" placeholder="Board meeting" />
                </Field>
              </div>
              <FormActions>
                <SubmitButton pendingLabel="Adding...">Add meeting</SubmitButton>
              </FormActions>
            </form>
          </Card>
        </section>
      )}

      <section className="space-y-3">
        <SectionHeader level="title">Meetings</SectionHeader>
        {meetings.length === 0 ? (
          <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
            No board meetings recorded for this term.
          </Card>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Date</TH>
                <TH>Title</TH>
                <TH>Recorded</TH>
                <TH>Absent</TH>
                <TH><span className="sr-only">Actions</span></TH>
              </TR>
            </THead>
            <tbody>
              {meetings.map((m) => (
                <TR key={m.id}>
                  <TD className="whitespace-nowrap text-sm text-foreground-soft">
                    {formatCalendarDate(m.meetingDate, { month: "short", day: "numeric", year: "numeric" })}
                  </TD>
                  <TD className="text-sm">{m.title ?? "Board meeting"}</TD>
                  <TD className="tabular-nums text-sm text-foreground-soft">{m.recordedCount}</TD>
                  <TD className="tabular-nums text-sm text-foreground-soft">{m.absentCount}</TD>
                  <TD>
                    <Link href={`${BASE}/${m.id}`} className="text-brand-fg hover:underline text-sm">
                      {isLiveTerm ? "Take attendance" : "View attendance"}
                    </Link>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader level="title">Unexcused absences this term</SectionHeader>
        {flagged.length === 0 ? (
          <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
            No unexcused absences recorded.
          </Card>
        ) : (
          <Card>
            <ul className="space-y-2">
              {flagged
                .sort((a, b) => b[1] - a[1])
                .map(([personId, count]) => (
                  <li key={personId} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-foreground">{nameById.get(personId) ?? "Unknown"}</span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums text-foreground-soft">{count}</span>
                      {/* The contract makes two unexcused absences worth one
                          strike. Flagged for a human to act on; nothing here
                          creates a strike. */}
                      {count >= 2 && <Badge tone="critical">At strike threshold</Badge>}
                    </span>
                  </li>
                ))}
            </ul>
            <p className="mt-4 text-xs text-subtle-foreground">
              Two unexcused absences equal one strike under the director contract. Raising a strike
              is a separate step in Incidents; nothing here issues one automatically.
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}
