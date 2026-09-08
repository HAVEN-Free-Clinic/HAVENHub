import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { requirePersonSession } from "@/platform/auth/session";
import {
  countAcceptedForCycle,
  getEventDetail,
  listCheckInCandidates,
  resolveAttendanceAuthority,
} from "@/modules/recruitment/services/attendance-events";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatDateTime } from "@/platform/dates";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { Alert } from "@/platform/ui/alert";
import { CheckInKiosk } from "@/modules/recruitment/components/check-in-kiosk";
import { checkInAction } from "../actions";
import { KIND_LABELS } from "@/app/(app)/recruitment/events/kind-labels";

export function generateMetadata() {
  return buildPageMetadata({
    title: "Event check-in",
    description: "Check people in at the door.",
  });
}

export default async function EventCheckInPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  const viewer = await requirePersonSession();

  const authority = await resolveAttendanceAuthority(viewer.personId);
  if (!authority.all && authority.departmentCodes.length === 0) redirect("/no-access");

  const detail = await getEventDetail(eventId);
  if (!detail) notFound();
  const { event, attendees } = detail;

  const [candidates, acceptedCount, zone] = await Promise.all([
    listCheckInCandidates(eventId, viewer.personId),
    countAcceptedForCycle(event.cycleId),
    getDisplayTimeZone(),
  ]);

  return (
    // Narrow and centered with generous vertical air: this is read standing up,
    // often at arm's length, and one column with nothing beside it is what makes
    // the next person's name the only thing on screen to look at.
    <div className="mx-auto max-w-2xl space-y-8 px-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{event.title}</h1>
          <p className="text-sm text-subtle-foreground">
            {KIND_LABELS[event.kind]} · {formatDateTime(event.startsAt, zone)}
            {event.location ? ` · ${event.location}` : ""}
          </p>
        </div>
        {/* The only way out, and deliberately the only other control on the
            screen. Lands on the attendance list rather than back where the
            operator came from, because that is where the session's record lives
            once the door closes. */}
        <Link
          href={`/recruitment/events/${eventId}`}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground-soft hover:text-foreground"
        >
          Exit check-in
        </Link>
      </header>

      {event.kind === "TRAINING" && (
        <Alert tone="info">
          Checking someone in here completes their training for this cycle, whether or not they
          have finished onboarding. Anyone with onboarding outstanding is emailed what is left.
        </Alert>
      )}

      {!authority.all && (
        <Alert tone="info">
          You can check in members of the departments you manage. Anyone else, including accepted
          applicants who have not onboarded, needs clinic-wide attendance permission.
        </Alert>
      )}

      <CheckInKiosk
        eventId={eventId}
        candidates={candidates}
        checkedInNames={attendees.map((a) => a.name)}
        acceptedCount={acceptedCount}
        // Named after the cohort rather than "Expected": the operator knows what
        // session they are running, and "Volunteers for this cycle" says which
        // of two piles a name in front of them belongs in without a legend.
        expectedHeading={
          event.cycleTrack === "DIRECTOR" ? "Directors for this cycle" : "Volunteers for this cycle"
        }
        action={checkInAction.bind(null, eventId)}
        allowWalkUps={authority.all}
      />
    </div>
  );
}
