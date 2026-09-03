import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import {
  canRecordAttendance,
  getEventDetail,
} from "@/modules/recruitment/services/attendance-events";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatDateTime, formatForDateTimeInput } from "@/platform/dates";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Alert } from "@/platform/ui/alert";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { buttonClasses } from "@/platform/ui/button";
import {
  deleteEventAction,
  linkAttendeeAction,
  removeCheckInAction,
  updateEventAction,
} from "../actions";
import { KIND_LABELS, kindTone } from "../kind-labels";

export function generateMetadata() {
  return buildPageMetadata({
    title: "Event attendance",
    description: "Who attended, and what is still outstanding for them.",
  });
}

export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requirePersonSession();
  if (!(await canRecordAttendance(viewer.personId))) redirect("/no-access");

  const [detail, canManage, zone] = await Promise.all([
    getEventDetail(id),
    can(viewer.personId, "recruitment.manage_cycles"),
    getDisplayTimeZone(),
  ]);
  if (!detail) notFound();
  const { event, attendees, linkSuggestions } = detail;
  const suggestionByAttendance = new Map(linkSuggestions.map((s) => [s.attendanceId, s]));
  const outstanding = attendees.filter((a) => a.blockers.length > 0).length;

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title={event.title}
        description={`${KIND_LABELS[event.kind]} · ${formatDateTime(event.startsAt, zone)}${
          event.location ? ` · ${event.location}` : ""
        }`}
        action={
          <Link
            href={`/recruitment/events/${event.id}/check-in`}
            className={buttonClasses("primary", "md")}
          >
            Open check-in
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-3 text-sm text-foreground-soft">
        <Badge tone={kindTone(event.kind)}>{KIND_LABELS[event.kind]}</Badge>
        <span>
          {attendees.length} checked in
          {outstanding > 0 && ` · ${outstanding} with onboarding outstanding`}
        </span>
        {event.cycleTitle && <span>Cycle: {event.cycleTitle}</span>}
      </div>

      {event.kind === "TRAINING" && !event.cycleTitle && (
        <Alert tone="warning">
          This training event has no recruitment cycle, so check-ins here record attendance but
          cannot complete anyone&apos;s training. Create a new training event under the right cycle.
        </Alert>
      )}

      <Table>
        <THead>
          <tr>
            <TH>Attendee</TH>
            <TH>Checked in</TH>
            <TH>Outstanding</TH>
            <TH className="text-right">Actions</TH>
          </tr>
        </THead>
        <tbody>
          {attendees.map((a) => {
            const suggestion = suggestionByAttendance.get(a.id);
            return (
              <TR key={a.id}>
                <TD className="font-medium text-foreground">
                  {a.name}
                  {a.email && <div className="text-xs text-subtle-foreground">{a.email}</div>}
                  {a.personId === null && (
                    <div className="mt-1">
                      <Badge tone="warning">Not linked to a person</Badge>
                    </div>
                  )}
                </TD>
                <TD className="text-foreground-soft">
                  {formatDateTime(a.checkedInAt, zone)}
                  {a.recordedByName && (
                    <div className="text-xs text-subtle-foreground">by {a.recordedByName}</div>
                  )}
                </TD>
                <TD className="text-foreground-soft">
                  {a.blockers.length === 0 ? (
                    <span className="text-success-foreground">Nothing</span>
                  ) : (
                    <ul className="list-disc pl-4 text-xs">
                      {a.blockers.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                  )}
                  {a.nudgeCount > 0 && (
                    <div className="text-xs text-subtle-foreground">
                      {a.nudgeCount} {a.nudgeCount === 1 ? "reminder" : "reminders"} sent
                    </div>
                  )}
                </TD>
                <TD>
                  <div className="flex items-center justify-end gap-2">
                    {suggestion && (
                      <form action={linkAttendeeAction.bind(null, event.id, a.id)}>
                        <input type="hidden" name="personId" value={suggestion.personId} />
                        <SubmitButton variant="outline" size="sm" pendingLabel="Linking…">
                          Link to {suggestion.personName}
                        </SubmitButton>
                      </form>
                    )}
                    <form action={removeCheckInAction.bind(null, event.id, a.id)}>
                      <ConfirmButton label="Remove" size="sm" />
                    </form>
                  </div>
                </TD>
              </TR>
            );
          })}
          {attendees.length === 0 && (
            <TR>
              <TD colSpan={4} className="py-10 text-center text-subtle-foreground">
                Nobody checked in yet.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>

      {canManage && (
        <Card>
          <h2 className="text-base font-semibold">Event details</h2>
          {/* Kind, cycle and term are deliberately not editable here: attendance
              already written under this event was credited according to its kind,
              so flipping an info session into a training afterwards would claim
              completions nobody recorded. */}
          <form action={updateEventAction.bind(null, event.id)} className="mt-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Title" required>
                <Input name="title" required defaultValue={event.title} />
              </Field>
              <Field label="Location">
                <Input name="location" defaultValue={event.location ?? ""} />
              </Field>
              <Field label="Starts" required>
                <Input
                  type="datetime-local"
                  name="startsAt"
                  required
                  defaultValue={formatForDateTimeInput(event.startsAt, zone)}
                />
              </Field>
              <Field label="Ends">
                <Input type="datetime-local" name="endsAt" defaultValue={formatForDateTimeInput(event.endsAt, zone)} />
              </Field>
            </div>
            <Field label="Notes">
              <Textarea name="notes" rows={2} defaultValue={event.notes ?? ""} />
            </Field>
            <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          </form>
          {/* A sibling of the edit form, never nested inside it: a <form> inside
              a <form> is invalid HTML and the inner one is dropped, which would
              leave a Delete button that silently submits the edit instead. */}
          {attendees.length === 0 && (
            <form action={deleteEventAction.bind(null, event.id)} className="mt-4">
              <ConfirmButton label="Delete event" size="sm" />
            </form>
          )}
        </Card>
      )}
    </div>
  );
}
