import { requireModuleAccess } from "@/platform/auth/session";
import { Card } from "@/platform/ui/card";
import { revalidatePath } from "next/cache";
import { formatCalendarDate, formatTimeOnly } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { getCheckInState, checkInSelf } from "@/modules/schedule/services/attendance";
import {
  CheckInPanel,
  type GeoPayload,
  type CheckInActionResult,
} from "@/modules/schedule/components/check-in-panel";
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

  if (!state.clinicDate) {
    return (
      <Card>
        <h1 className="text-xl font-bold text-foreground">No clinic today</h1>
        <p className="mt-2 text-sm text-subtle-foreground">
          There is no clinic scheduled for today, so there is nothing to check in to.
        </p>
      </Card>
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
    return (
      <Card>
        <h1 className="text-xl font-bold text-foreground">You are checked in</h1>
        <p className="mt-2 text-sm text-subtle-foreground">
          {dateLabel}, at {timeLabel}.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="text-xl font-bold text-foreground">Check in for {dateLabel}</h1>
      <div className="mt-4">
        <CheckInPanel mode={state.allRemote ? "remote" : "geo"} action={checkInAction} />
      </div>
    </Card>
  );
}
