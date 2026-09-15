import { isPlausibleFix } from "@/modules/schedule/engine/geofence";
import type { ClientDetectedFailureReason } from "./check-in-client-reasons";

/**
 * Best-of-several location sampling for clinic check-in.
 *
 * getCurrentPosition resolves with the FIRST fix the device produces, and on a
 * phone that is often a wifi or cell-tower estimate GPS would have tightened a
 * few seconds later. This watches the position instead, keeps the most precise
 * fix seen, and stops at the first one that is good enough, when the settle
 * window closes with a usable one, or at the hard timeout with none.
 *
 * It takes the Geolocation object as an argument and touches no React, so
 * tests drive it with a fake and fake timers.
 */

export type Fix = { latitude: number; longitude: number; accuracyMeters: number };

export type SampleOutcome = { ok: true; fix: Fix } | { ok: false; reason: ClientDetectedFailureReason };

/** The slice of the Geolocation API the sampler uses. */
export type GeoLike = {
  watchPosition(
    success: PositionCallback,
    error?: PositionErrorCallback | null,
    options?: PositionOptions,
  ): number;
  clearWatch(id: number): void;
};

export type SamplerOptions = {
  /** Stop at the first fix at least this precise, in metres. */
  targetAccuracyMeters: number;
  /** After this long, send the best fix seen rather than wait for a better one. */
  settleMs: number;
  /** Give up if no usable fix has arrived by now. */
  timeoutMs: number;
  /** Called each time the best fix improves, so the button can show it. */
  onProgress?: (best: Fix) => void;
};

/**
 * Successful self check-ins in production (Aug-Sep 2026) reported 9-55 m, so
 * 25 m is a fix most phones reach within a few seconds, and 8 s bounds how
 * long anyone stands watching the button when theirs never does.
 */
export const DEFAULT_SAMPLER_OPTIONS: SamplerOptions = {
  targetAccuracyMeters: 25,
  settleMs: 8_000,
  timeoutMs: 15_000,
};

export function sampleBestFix(
  geo: GeoLike,
  options: SamplerOptions = DEFAULT_SAMPLER_OPTIONS,
): Promise<SampleOutcome> {
  const { targetAccuracyMeters, settleMs, timeoutMs, onProgress } = options;

  return new Promise((resolve) => {
    let best: Fix | null = null;
    let settled = false;
    let done = false;
    let watchId: number | null = null;
    // Reported only if no fix ever arrives. iOS says POSITION_UNAVAILABLE while
    // GPS is still acquiring and then recovers, so it cannot end the attempt.
    let lastError: ClientDetectedFailureReason = "TIMEOUT";

    // The timers exist before watchPosition is called, so a browser that
    // answers synchronously finds them there to clear.
    const settleTimer = setTimeout(() => {
      settled = true;
      if (best) finish({ ok: true, fix: best });
    }, settleMs);
    const timeoutTimer = setTimeout(() => {
      finish(best ? { ok: true, fix: best } : { ok: false, reason: lastError });
    }, timeoutMs);

    function finish(outcome: SampleOutcome) {
      if (done) return;
      done = true;
      clearTimeout(settleTimer);
      clearTimeout(timeoutTimer);
      if (watchId !== null) geo.clearWatch(watchId);
      resolve(outcome);
    }

    const id = geo.watchPosition(
      (pos) => {
        if (done) return;
        const fix: Fix = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyMeters: pos.coords.accuracy,
        };
        if (!isPlausibleFix(fix, fix.accuracyMeters)) return;

        if (best === null || fix.accuracyMeters < best.accuracyMeters) {
          best = fix;
          onProgress?.(fix);
        }
        if (best.accuracyMeters <= targetAccuracyMeters || settled) finish({ ok: true, fix: best });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          finish({ ok: false, reason: "PERMISSION_DENIED" });
          return;
        }
        lastError = err.code === err.TIMEOUT ? "TIMEOUT" : "POSITION_UNAVAILABLE";
      },
      // maximumAge 0: a cached fix could be from before the volunteer arrived.
      { enableHighAccuracy: true, maximumAge: 0 },
    );
    watchId = id;
    if (done) geo.clearWatch(id);
  });
}
