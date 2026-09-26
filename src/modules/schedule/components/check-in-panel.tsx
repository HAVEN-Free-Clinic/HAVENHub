"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import type { ClientDetectedFailureReason } from "./check-in-client-reasons";
import { DEFAULT_SAMPLER_OPTIONS, sampleBestFix } from "./location-sampler";
import { detectLocationPlatform, locationUnblockSteps, type LocationPlatform } from "./location-help";

export type GeoPayload = { latitude: number; longitude: number; accuracyMeters: number };

export type CheckInActionResult =
  | { ok: true; checkedInAt: string; alreadyCheckedIn: boolean }
  | { ok: false; reason: string };

/**
 * Copy for every failure the volunteer can see. Every message, with no
 * exception, ends by pointing at a director: OUT_OF_RANGE, because wifi-derived
 * geolocation puts genuinely present people hundreds of metres away often
 * enough that treating distance as proof of absence would be wrong; and
 * NOT_ELIGIBLE, because even though markPresent (the director override)
 * enforces the same ACTIVE-status gate checkInSelf does -- so a director
 * cannot simply wave the person through -- a director can often resolve the
 * underlying status problem itself (a data error, a delayed offboarding flip,
 * a membership that needs renewing). Leaving someone standing in the clinic
 * with no next step at all is the exact failure mode this rule exists to
 * prevent, so the copy names the problem and points at a director without
 * promising an override.
 */
const FAILURE_COPY: Record<string, string> = {
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
  NOT_ELIGIBLE:
    "Your membership is not showing as active, so check-in is unavailable. Ask a director to look into why.",
  FENCE_UNCONFIGURED:
    "Check-in is not configured yet. Ask a director to check you in and let an admin know.",
  UNAVAILABLE: "Check-in could not be recorded right now. Ask a director to check you in.",
};

/**
 * PERMISSION_DENIED gets its own state rather than a FAILURE_COPY line. A
 * browser that has been told "Don't Allow" never asks again: every later tap
 * is refused instantly, so "try again" copy sent people tapping. In production
 * (Sep 2026) every one of 17 rage clicks on Check in came from a denied device,
 * and about half of each week's denied volunteers never checked themselves in.
 * So the copy says outright that tapping will not help, lists the steps for
 * this device, and still ends at a director (markPresent), per the rule above.
 */
const BLOCKED =
  "Location is blocked for this site, so check-in cannot confirm you are at the clinic. Tapping Check in will not work until you allow it:";
const BLOCKED_FALLBACK = "Or ask a director to check you in.";
const UNBLOCKED = "Location is allowed now. Tap Check in.";

/**
 * `taps` counts denied attempts: 0 when the browser said "denied" before any
 * tap. Each denied tap bumps it, which remounts the alert (so a screen reader
 * announces it again) and changes its first line, so a retry never looks dead.
 */
type Blocked = { platform: LocationPlatform; taps: number };

function currentPlatform(): LocationPlatform {
  return detectLocationPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

export function CheckInPanel({
  mode,
  action,
  reportClientFailure,
}: {
  mode: "geo" | "remote";
  action: (payload: GeoPayload | null) => Promise<CheckInActionResult>;
  /**
   * Fire-and-forget analytics for a failure the client detected before ever
   * calling `action` (declined permission, no fix, timed out). Without this,
   * the most common real-world failure -- declining the location prompt --
   * would never reach PostHog, because `action` (the only path that captures
   * an event) is never invoked for it. Purely a capture: the result is not
   * awaited for correctness and cannot affect what the volunteer sees.
   */
  reportClientFailure: (reason: ClientDetectedFailureReason) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  // The best accuracy seen so far while sampling, shown on the button.
  const [accuracy, setAccuracy] = useState<number | null>(null);
  // Set while location is blocked: the steps for this device render under the
  // message, because a blocked browser never asks again on its own.
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  // Set when a block this page showed has since been lifted in settings.
  const [unblocked, setUnblocked] = useState(false);

  // A volunteer who blocked location on an earlier visit would otherwise learn
  // it only by tapping. Where the browser can say so up front, show the steps
  // before they try, and follow later changes so allowing location in settings
  // clears the block without a reload. Nothing is reported: no attempt has
  // been made yet. Older Safari has no Permissions API or rejects the
  // geolocation query; both fall through to finding out on the first tap.
  useEffect(() => {
    if (mode !== "geo" || !("permissions" in navigator)) return;
    let live = true;
    let status: PermissionStatus | null = null;
    let last: PermissionState | null = null;

    function onState(state: PermissionState) {
      if (state === "denied") {
        setBlocked((prev) => prev ?? { platform: currentPlatform(), taps: 0 });
        setUnblocked(false);
      } else if (last === "denied") {
        // Only a move OUT of denied counts: prompt -> granted also fires while
        // someone answers the first prompt, mid check-in.
        setBlocked(null);
        setUnblocked(true);
      }
      last = state;
    }
    const onChange = () => {
      if (live && status) onState(status.state);
    };

    navigator.permissions
      .query({ name: "geolocation" })
      .then((result) => {
        if (!live) return;
        status = result;
        onState(result.state);
        result.addEventListener?.("change", onChange);
      })
      .catch(() => {});
    return () => {
      live = false;
      status?.removeEventListener?.("change", onChange);
    };
  }, [mode]);

  function submit(payload: GeoPayload | null) {
    startTransition(async () => {
      const result = await action(payload);
      if (!result.ok) setError(FAILURE_COPY[result.reason] ?? FAILURE_COPY.UNAVAILABLE);
    });
  }

  function onClick() {
    // `blocked` is left up: a denied browser refuses within milliseconds, and
    // clearing it here would only make it blink back identically.
    setError(null);
    setUnblocked(false);

    if (mode === "remote") {
      submit(null);
      return;
    }

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      fail("POSITION_UNAVAILABLE");
      return;
    }

    setLocating(true);
    setAccuracy(null);
    void sampleBestFix(navigator.geolocation, {
      ...DEFAULT_SAMPLER_OPTIONS,
      onProgress: (best) => setAccuracy(Math.round(best.accuracyMeters)),
    }).then((outcome) => {
      setLocating(false);
      if (!outcome.ok) {
        fail(outcome.reason);
        return;
      }
      setBlocked(null);
      submit(outcome.fix);
    });
  }

  function fail(reason: ClientDetectedFailureReason) {
    if (reason === "PERMISSION_DENIED") {
      setBlocked((prev) => ({ platform: currentPlatform(), taps: (prev?.taps ?? 0) + 1 }));
    } else {
      setError(FAILURE_COPY[reason]);
      setBlocked(null);
    }
    report(reason);
  }

  // Best-effort: never awaited, never lets an analytics hiccup surface as a
  // user-visible error on top of the one already shown.
  function report(reason: ClientDetectedFailureReason) {
    reportClientFailure(reason).catch(() => {});
  }

  const busy = pending || locating;

  return (
    <div className="flex flex-col gap-4">
      {error && <Alert tone="warning">{error}</Alert>}
      {blocked && !error && (
        <Alert tone="warning" key={`blocked-${blocked.taps}`} data-testid="check-in-blocked">
          {blocked.taps > 1 && (
            <p className="font-semibold">Still blocked after {blocked.taps} tries.</p>
          )}
          <p>{BLOCKED}</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            {locationUnblockSteps(blocked.platform).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="mt-2">{BLOCKED_FALLBACK}</p>
        </Alert>
      )}
      {unblocked && !blocked && !error && <Alert tone="success">{UNBLOCKED}</Alert>}
      <Button onClick={onClick} disabled={busy}>
        {locating
          ? accuracy === null
            ? "Finding your location…"
            : `Finding your location… ±${accuracy} m`
          : pending
            ? "Checking you in…"
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
