import { requireModuleAccess } from "@/platform/auth/session";
import { Card } from "@/platform/ui/card";
import { PageHeader } from "@/platform/ui/page-header";
import { revalidatePath } from "next/cache";
import { formatCalendarDate, formatTimeOnly } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { getCheckInState, checkInSelf } from "@/modules/schedule/services/attendance";
import {
  CheckInPanel,
  type GeoPayload,
  type CheckInActionResult,
} from "@/modules/schedule/components/check-in-panel";
import { isClientDetectedFailureReason } from "@/modules/schedule/components/check-in-client-reasons";
import { captureEvent } from "@/platform/posthog/capture";
import { termGroup } from "@/platform/posthog/groups";
import { buildPageMetadata } from "@/platform/branding/metadata";

// buildPageMetadata is async, so it goes through generateMetadata, not a static
// `export const metadata`. This matches src/app/(app)/page.tsx.
export function generateMetadata() {
  return buildPageMetadata({
    title: "Clinic check-in",
    description: "Check in for today's clinic shift.",
  });
}

export default async function CheckInPage() {
  const session = await requireModuleAccess("schedule");
  const state = await getCheckInState(session.personId);

  async function checkInAction(payload: GeoPayload | null): Promise<CheckInActionResult> {
    "use server";
    const actor = await requireModuleAccess("schedule");

    const result = await checkInSelf(
      actor.personId,
      payload
        ? {
            coords: { latitude: payload.latitude, longitude: payload.longitude },
            accuracyMeters: payload.accuracyMeters,
          }
        : null,
    );

    // Capture EVERY outcome the service can produce, success and each distinct
    // failure reason. This is how the radius and accuracy thresholds get tuned
    // from real data rather than anecdote. captureEvent never throws, so it
    // cannot break a committed check-in.
    await captureEvent({
      distinctId: actor.personId,
      event: result.ok ? "clinic_check_in_succeeded" : "clinic_check_in_failed",
      properties: result.ok
        ? { method: result.method, alreadyCheckedIn: result.alreadyCheckedIn }
        : { reason: result.reason },
      groups: termGroup(state.termId),
    });

    if (!result.ok) return { ok: false, reason: result.reason };

    revalidatePath("/schedule/check-in");
    revalidatePath("/schedule");
    return {
      ok: true,
      checkedInAt: result.checkedInAt.toISOString(),
      alreadyCheckedIn: result.alreadyCheckedIn,
    };
  }

  /**
   * Analytics-only: captures a failure the CLIENT detected before ever
   * reaching checkInAction (declined the location prompt, no fix, timed out).
   * These are the most common real-world failures, and without this they were
   * invisible to PostHog -- checkInAction is the only path that captures an
   * event, and the client never called it for them.
   *
   * `reason` is untrusted wire input, not the typed value the panel sends: a
   * caller could invoke this action directly with anything. It is validated
   * against the exact set the client can genuinely produce and dropped
   * otherwise, and it is NEVER passed to checkInSelf or used to write
   * anything -- worst case for a forged value is a dropped capture, never a
   * false attendance row or an influenced verdict.
   *
   * A distinct event name (not a `source` property on clinic_check_in_failed)
   * keeps a server-ruled failure and a client-reported one from being
   * conflated in the funnel later.
   */
  async function reportClientFailure(reason: string): Promise<void> {
    "use server";
    const actor = await requireModuleAccess("schedule");
    if (!isClientDetectedFailureReason(reason)) return;
    await captureEvent({
      distinctId: actor.personId,
      event: "clinic_check_in_client_failed",
      properties: { reason },
      groups: termGroup(state.termId),
    });
  }

  if (!state.clinicDate) {
    return (
      <PageHeader
        title="No clinic today"
        description="There is no clinic scheduled for today, so there is nothing to check in to."
      />
    );
  }

  const dateLabel = formatCalendarDate(state.clinicDate, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  if (state.existing) {
    // checkedInAt is a real instant (not a calendar marker like clinicDate), so
    // it renders in the app's configurable display zone, not the server's own
    // zone -- matching how every other instant in the app is shown.
    const zone = await getDisplayTimeZone();
    const timeLabel = formatTimeOnly(state.existing.checkedInAt, zone, {
      hour: "numeric",
      minute: "2-digit",
    });
    return <PageHeader title="You are checked in" description={`${dateLabel}, at ${timeLabel}.`} />;
  }

  return (
    <div>
      <div className="mb-8">
        <PageHeader title={`Check in for ${dateLabel}`} />
      </div>
      <Card>
        <CheckInPanel
          mode={state.allRemote ? "remote" : "geo"}
          action={checkInAction}
          reportClientFailure={reportClientFailure}
        />
      </Card>
    </div>
  );
}
