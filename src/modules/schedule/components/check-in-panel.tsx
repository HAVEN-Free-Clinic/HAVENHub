"use client";

import { useState, useTransition } from "react";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";

export type GeoPayload = { latitude: number; longitude: number; accuracyMeters: number };

export type CheckInActionResult =
  | { ok: true; checkedInAt: string; alreadyCheckedIn: boolean }
  | { ok: false; reason: string };

/**
 * Copy for every failure the volunteer can see. Every message except the
 * not-a-clinic-day one ends by pointing at a director, INCLUDING out-of-range:
 * wifi-derived geolocation puts genuinely present people hundreds of metres away
 * often enough that treating distance as proof of absence would be wrong.
 *
 * NOT_ELIGIBLE is the one deliberate exception to that rule: markPresent (the
 * director override) enforces the same ACTIVE-status gate checkInSelf does, so
 * a director literally cannot check in someone whose membership is not active.
 * Pointing them at a director here would be a false promise.
 */
const FAILURE_COPY: Record<string, string> = {
  PERMISSION_DENIED:
    "Your device would not share its location. Turn on location for this site and try again, or ask a director to check you in.",
  POSITION_UNAVAILABLE:
    "Your device could not work out where it is. Try again near a window, or ask a director to check you in.",
  TIMEOUT: "Finding your location took too long. Try again, or ask a director to check you in.",
  TOO_IMPRECISE:
    "Your location was too imprecise to confirm you are at the clinic. This is common indoors. Ask a director to check you in.",
  OUT_OF_RANGE:
    "You do not appear to be at the clinic. If you are here, your device's location may be off; ask a director to check you in.",
  NOT_ASSIGNED:
    "You are not on the schedule for today. If you are covering a shift, ask a director to check you in.",
  NOT_A_CLINIC_DAY: "There is no clinic today, so there is nothing to check in to.",
  NOT_ELIGIBLE: "Your membership is not active, so check-in is unavailable.",
  FENCE_UNCONFIGURED:
    "Check-in is not configured yet. Ask a director to check you in and let an admin know.",
  UNAVAILABLE: "Check-in could not be recorded right now. Ask a director to check you in.",
};

export function CheckInPanel({
  mode,
  action,
}: {
  mode: "geo" | "remote";
  action: (payload: GeoPayload | null) => Promise<CheckInActionResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  function submit(payload: GeoPayload | null) {
    startTransition(async () => {
      const result = await action(payload);
      if (!result.ok) setError(FAILURE_COPY[result.reason] ?? FAILURE_COPY.UNAVAILABLE);
    });
  }

  function onClick() {
    setError(null);

    if (mode === "remote") {
      submit(null);
      return;
    }

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError(FAILURE_COPY.POSITION_UNAVAILABLE);
      return;
    }

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        submit({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyMeters: pos.coords.accuracy,
        });
      },
      (err) => {
        setLocating(false);
        // Map the browser's own codes so the message is specific.
        const reason =
          err.code === err.PERMISSION_DENIED
            ? "PERMISSION_DENIED"
            : err.code === err.TIMEOUT
              ? "TIMEOUT"
              : "POSITION_UNAVAILABLE";
        setError(FAILURE_COPY[reason]);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  const busy = pending || locating;

  return (
    <div className="flex flex-col gap-4">
      {error && <Alert tone="warning">{error}</Alert>}
      <Button onClick={onClick} disabled={busy}>
        {locating
          ? "Finding your location..."
          : pending
            ? "Checking you in..."
            : mode === "remote"
              ? "Check in (telehealth)"
              : "Check in"}
      </Button>
      {mode === "geo" && (
        <p className="text-sm text-subtle-foreground">
          Check-in confirms you are at the clinic, so your device will ask to share your location.
          Only your rounded distance from the clinic is stored, never your coordinates.
        </p>
      )}
    </div>
  );
}
