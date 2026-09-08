"use server";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import {
  AttendanceEventError,
  CheckInConfirmationRequired,
  recordEventCheckIn,
  type CheckInResult,
  type CheckInTarget,
} from "@/modules/recruitment/services/attendance-events";
import { prisma } from "@/platform/db";
import { captureEvent } from "@/platform/posthog/capture";
import { termGroup } from "@/platform/posthog/groups";

/**
 * The door screen's check-in action.
 *
 * Returns a result rather than redirecting: the screen stays put while a queue
 * moves past it, and a redirect per person would throw away the search box and
 * the operator's place in the line. Errors come back in the same shape for the
 * same reason -- a refusal at a door has to be readable without losing the
 * screen.
 */
export async function checkInAction(
  eventId: string,
  target: CheckInTarget,
): Promise<CheckInResult> {
  const person = await requirePersonSession();
  try {
    const outcome = await recordEventCheckIn(eventId, target, person.personId);
    // Capture every outcome, success and refusal alike, the way clinic check-in
    // does: how often walk-ups happen and how often attendees turn up with
    // onboarding outstanding are exactly the numbers this feature exists to
    // learn, and neither is knowable from the database alone once rows are
    // linked and blockers clear.
    await captureEvent({
      distinctId: person.personId,
      event: "event_check_in_succeeded",
      properties: {
        eventId,
        targetKind: target.kind,
        alreadyCheckedIn: outcome.alreadyCheckedIn,
        trainingCredited: outcome.trainingCredited,
        blockerCount: outcome.blockers.length,
        nudgeQueued: outcome.nudgeQueued,
      },
      groups: await eventGroups(eventId),
    });
    // The event page is a different route, so it needs saying explicitly; this
    // page's own server components re-render on the action regardless, which is
    // what refreshes the candidate list and the checked-in count.
    revalidatePath(`/recruitment/events/${eventId}`);
    return { ok: true, ...outcome };
  } catch (err) {
    // Not a failure and not captured as one: nothing was attempted yet, and
    // counting the question as a refused check-in would put a permanent bump in
    // the failure rate every time a door asked one.
    if (err instanceof CheckInConfirmationRequired) {
      return { ok: false, message: err.message, requiresConfirmation: true };
    }
    if (err instanceof RecruitmentAuthError || err instanceof AttendanceEventError) {
      await captureEvent({
        distinctId: person.personId,
        event: "event_check_in_failed",
        properties: { eventId, targetKind: target.kind, reason: (err as Error).name },
        groups: await eventGroups(eventId),
      });
      return { ok: false, message: (err as Error).message };
    }
    throw err;
  }
}

/** The event's term as a PostHog group, so check-in analytics slice by term. */
async function eventGroups(eventId: string): Promise<Record<string, string> | undefined> {
  const event = await prisma.attendanceEvent.findUnique({
    where: { id: eventId },
    select: { termId: true },
  });
  return event ? termGroup(event.termId) : undefined;
}
