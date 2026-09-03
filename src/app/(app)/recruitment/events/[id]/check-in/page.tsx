import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import {
  getEventDetail,
  listCheckInCandidates,
  resolveAttendanceAuthority,
} from "@/modules/recruitment/services/attendance-events";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatDateTime } from "@/platform/dates";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { Alert } from "@/platform/ui/alert";
import { CheckInKiosk } from "@/modules/recruitment/components/check-in-kiosk";
import { checkInAction } from "../../actions";
import { KIND_LABELS } from "../../kind-labels";

export function generateMetadata() {
  return buildPageMetadata({
    title: "Event check-in",
    description: "Check people in at the door.",
  });
}

export default async function EventCheckInPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requirePersonSession();

  const authority = await resolveAttendanceAuthority(viewer.personId);
  if (!authority.all && authority.departmentCodes.length === 0) redirect("/no-access");

  const [detail, candidates, zone] = await Promise.all([
    getEventDetail(id),
    listCheckInCandidates(id, viewer.personId),
    getDisplayTimeZone(),
  ]);
  if (!detail) notFound();
  const { event, attendees } = detail;

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        title={`Check in: ${event.title}`}
        description={`${KIND_LABELS[event.kind]} · ${formatDateTime(event.startsAt, zone)}${
          event.location ? ` · ${event.location}` : ""
        }`}
      />

      {event.kind === "TRAINING" && (
        <Alert tone="info">
          Checking someone in here completes their training for this cycle, whether or not they
          have finished onboarding. Anyone with onboarding outstanding is emailed what is left.
        </Alert>
      )}

      {!authority.all && (
        <Alert tone="info">
          You can check in members of the departments you manage. Anyone else, including people
          with no hub record, needs clinic-wide attendance permission.
        </Alert>
      )}

      <CheckInKiosk
        candidates={candidates}
        checkedInNames={attendees.map((a) => a.name)}
        action={checkInAction.bind(null, id)}
        allowWalkUps={authority.all}
      />

      <Link
        href={`/recruitment/events/${id}`}
        className="inline-block text-sm font-medium text-brand hover:underline"
      >
        Back to the attendance list
      </Link>
    </div>
  );
}
