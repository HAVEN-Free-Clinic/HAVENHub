import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  meetingRoster,
  markAttendance,
  BOARD_ATTENDANCE_STATUSES,
  BoardAttendanceValidationError,
  BoardAttendanceForbiddenError,
} from "@/modules/volunteers/services/board-attendance";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Select } from "@/platform/ui/select";
import { Input } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { formatCalendarDate } from "@/platform/dates";
import type { BoardAttendanceStatus } from "@prisma/client";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
};

const STATUS_TONE: Record<BoardAttendanceStatus, "success" | "warning" | "critical"> = {
  PRESENT: "success",
  EXCUSED: "warning",
  ABSENT: "critical",
};

export default async function BoardMeetingPage({ params, searchParams }: PageProps) {
  await requirePermission("volunteers.manage_board_attendance");
  const { id } = await params;
  const sp = await searchParams;

  const meeting = await prisma.boardMeeting.findUnique({
    where: { id },
    select: { id: true, meetingDate: true, title: true, term: { select: { id: true, name: true, status: true } } },
  });
  if (!meeting) notFound();

  const roster = await meetingRoster(id);
  const outstanding = roster.filter((r) => r.status === null).length;

  // Carry the term through, so backing out of a 2024 meeting lands on the 2024
  // list rather than silently on the current term's.
  const backHref =
    meeting.term.status === "ACTIVE"
      ? "/volunteers/board-meetings"
      : `/volunteers/board-meetings?term=${meeting.term.id}`;

  async function markAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.manage_board_attendance");
    try {
      await markAttendance(actor.personId, {
        meetingId: id,
        personId: String(formData.get("personId") ?? ""),
        status: String(formData.get("status") ?? "") as BoardAttendanceStatus,
        note: String(formData.get("note") ?? ""),
      });
    } catch (err) {
      if (err instanceof BoardAttendanceValidationError || err instanceof BoardAttendanceForbiddenError) {
        redirect(`/volunteers/board-meetings/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/volunteers/board-meetings/${id}`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={meeting.title ?? "Board meeting"}
        description={`${formatCalendarDate(meeting.meetingDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} · ${meeting.term.name}`}
      />

      <Link href={backHref} className="text-brand-fg hover:underline text-sm">
        Back to meetings
      </Link>

      {sp.error && <Alert tone="error">{sp.error}</Alert>}

      {roster.length === 0 ? (
        <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
          Nobody was recorded at this meeting, and this term has no active directors to record.
        </Card>
      ) : (
        <>
          {outstanding > 0 && (
            // Not-recorded is deliberately not an absence, so an unfinished
            // meeting has to be visibly unfinished rather than quietly counting
            // as everyone present or everyone absent.
            <p className="text-sm text-subtle-foreground">
              {outstanding} of {roster.length} not yet recorded.
            </p>
          )}
          <Table>
            <THead>
              <TR>
                <TH>Director</TH>
                <TH>Department</TH>
                <TH>Status</TH>
                <TH>Record</TH>
              </TR>
            </THead>
            <tbody>
              {roster.map((r) => (
                <TR key={r.personId}>
                  <TD className="font-medium text-foreground">{r.name}</TD>
                  <TD className="text-sm text-foreground-soft">{r.departmentNames.join(", ")}</TD>
                  <TD>
                    {r.status ? (
                      <Badge tone={STATUS_TONE[r.status]}>{r.status.toLowerCase()}</Badge>
                    ) : (
                      <span className="text-xs text-subtle-foreground">Not recorded</span>
                    )}
                    {r.note && (
                      <span className="mt-0.5 block text-xs text-subtle-foreground">{r.note}</span>
                    )}
                  </TD>
                  <TD>
                    <form action={markAction} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="personId" value={r.personId} />
                      <div className="w-32">
                        <Select name="status" defaultValue={r.status ?? "PRESENT"} aria-label={`Status for ${r.name}`}>
                          {BOARD_ATTENDANCE_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s.charAt(0) + s.slice(1).toLowerCase()}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <Input
                        name="note"
                        defaultValue={r.note ?? ""}
                        placeholder="Note"
                        aria-label={`Note for ${r.name}`}
                        className="min-w-32 flex-1"
                      />
                      <SubmitButton size="sm" variant="outline" pendingLabel="Saving...">Save</SubmitButton>
                    </form>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </div>
  );
}
