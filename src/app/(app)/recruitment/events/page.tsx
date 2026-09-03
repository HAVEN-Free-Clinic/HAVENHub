import Link from "next/link";
import { requirePersonSession } from "@/platform/auth/session";
import { redirect } from "next/navigation";
import { can } from "@/platform/rbac/engine";
import {
  canRecordAttendance,
  listEvents,
} from "@/modules/recruitment/services/attendance-events";
import { listCycles } from "@/modules/recruitment/services/cycles";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatDateTime } from "@/platform/dates";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Alert } from "@/platform/ui/alert";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { createEventAction } from "./actions";
import { KIND_LABELS, kindTone } from "./kind-labels";

export function generateMetadata() {
  return buildPageMetadata({
    title: "Attendance events",
    description: "Take attendance at training sessions, info sessions and other events.",
  });
}

export default async function EventsPage() {
  const viewer = await requirePersonSession();
  // Gate on the capability, not on recruitment.access: a door staffer may hold
  // recruitment.record_attendance and nothing else, and a department director is
  // admitted by review scope with no recruitment permission at all.
  if (!(await canRecordAttendance(viewer.personId))) redirect("/no-access");

  const [term, canManage, zone] = await Promise.all([
    getActiveTerm(),
    can(viewer.personId, "recruitment.manage_cycles"),
    getDisplayTimeZone(),
  ]);
  // Scoped to the active term: an event list spanning every term the clinic has
  // ever run is an archive, not a working surface. Past terms' rows stay
  // reachable through the cycle they belong to.
  const events = await listEvents(term ? { termId: term.id } : {});
  const cycles = canManage ? await listCycles() : [];

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Attendance events"
        description={
          term
            ? `Training sessions, info sessions and other events in ${term.name}.`
            : "Training sessions, info sessions and other events."
        }
      />

      {!term && (
        <Alert tone="warning">
          No term is active, so new events have to be attached to a recruitment cycle.
        </Alert>
      )}

      <Table>
        <THead>
          <tr>
            <TH>Event</TH>
            <TH>When</TH>
            <TH>Cycle</TH>
            <TH className="text-right">Checked in</TH>
            <TH className="text-right">Actions</TH>
          </tr>
        </THead>
        <tbody>
          {events.map((event) => (
            <TR key={event.id}>
              <TD className="font-medium text-foreground">
                <Link href={`/recruitment/events/${event.id}`} className="hover:underline">
                  {event.title}
                </Link>
                <div className="mt-1">
                  <Badge tone={kindTone(event.kind)}>{KIND_LABELS[event.kind]}</Badge>
                </div>
              </TD>
              <TD className="text-foreground-soft">
                {formatDateTime(event.startsAt, zone)}
                {event.location && (
                  <div className="text-xs text-subtle-foreground">{event.location}</div>
                )}
              </TD>
              <TD className="text-foreground-soft">{event.cycleTitle ?? "-"}</TD>
              <TD className="text-right text-foreground-soft">
                {event.attendeeCount}
                {event.unlinkedCount > 0 && (
                  <div className="text-xs text-subtle-foreground">
                    {event.unlinkedCount} not linked
                  </div>
                )}
              </TD>
              <TD className="text-right">
                <Link
                  href={`/recruitment/events/${event.id}/check-in`}
                  className="text-sm font-medium text-brand hover:underline"
                >
                  Check in
                </Link>
              </TD>
            </TR>
          ))}
          {events.length === 0 && (
            <TR>
              <TD colSpan={5} className="py-10 text-center text-subtle-foreground">
                No events yet.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>

      {canManage && (
        <Card>
          <h2 className="text-base font-semibold">New event</h2>
          <form action={createEventAction} className="mt-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Title" required>
                <Input name="title" required placeholder="Fall 2026 info session" />
              </Field>
              <Field label="Kind" required>
                <Select name="kind" required defaultValue="INFO_SESSION">
                  <option value="INFO_SESSION">{KIND_LABELS.INFO_SESSION}</option>
                  <option value="TRAINING">{KIND_LABELS.TRAINING}</option>
                  <option value="OTHER">{KIND_LABELS.OTHER}</option>
                </Select>
              </Field>
              <Field label="Starts" required>
                <Input type="datetime-local" name="startsAt" required />
              </Field>
              <Field label="Ends" hint="Optional.">
                <Input type="datetime-local" name="endsAt" />
              </Field>
              <Field
                label="Recruitment cycle"
                hint="Required for a training session: its cycle is what decides which track the attendance completes training for."
              >
                <Select name="cycleId" defaultValue="">
                  <option value="">No cycle</option>
                  {cycles.map((cycle) => (
                    <option key={cycle.id} value={cycle.id}>
                      {cycle.title}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Location">
                <Input name="location" placeholder="SHM L110" />
              </Field>
            </div>
            <Field label="Notes">
              <Textarea name="notes" rows={2} />
            </Field>
            <SubmitButton pendingLabel="Creating…">Create event</SubmitButton>
          </form>
        </Card>
      )}
    </div>
  );
}
