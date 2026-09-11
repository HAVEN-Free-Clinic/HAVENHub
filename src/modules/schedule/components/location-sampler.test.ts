import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sampleBestFix, type SampleOutcome } from "./location-sampler";

const OPTS = { targetAccuracyMeters: 25, settleMs: 8_000, timeoutMs: 15_000 };

/**
 * A Geolocation stand-in the test drives by hand: it keeps the callbacks
 * watchPosition was given, so each test delivers fixes and errors exactly when
 * it wants while fake timers own the clock.
 */
function fakeGeo() {
  let onFix: PositionCallback = () => {};
  let onError: PositionErrorCallback = () => {};
  const geo = {
    watchPosition: vi.fn(
      (success: PositionCallback, error?: PositionErrorCallback | null, _options?: PositionOptions) => {
        onFix = success;
        onError = error ?? (() => {});
        return 7;
      },
    ),
    clearWatch: vi.fn((_id: number) => {}),
  };
  return {
    geo,
    fix(accuracy: number, latitude = 41.3026, longitude = -72.9363) {
      onFix({ coords: { latitude, longitude, accuracy } } as GeolocationPosition);
    },
    fail(code: 1 | 2 | 3) {
      onError({
        code,
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
        message: "",
      } as GeolocationPositionError);
    },
  };
}

/** Record the outcome without awaiting, so a test can assert "not yet". */
function track(promise: Promise<SampleOutcome>) {
  const box: { outcome?: SampleOutcome } = {};
  void promise.then((o) => {
    box.outcome = o;
  });
  return box;
}

describe("sampleBestFix", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for a fresh high-accuracy fix, never a cached one", () => {
    const g = fakeGeo();
    void sampleBestFix(g.geo, OPTS);
    expect(g.geo.watchPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ enableHighAccuracy: true, maximumAge: 0 }),
    );
  });

  it("stops at the first fix that meets the target and cleans up after itself", async () => {
    const g = fakeGeo();
    const box = track(sampleBestFix(g.geo, OPTS));

    g.fix(60);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(box.outcome).toBeUndefined();

    g.fix(12);
    await vi.advanceTimersByTimeAsync(0);
    expect(box.outcome).toEqual({
      ok: true,
      fix: { latitude: 41.3026, longitude: -72.9363, accuracyMeters: 12 },
    });
    expect(g.geo.clearWatch).toHaveBeenCalledWith(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends the most precise fix seen when the target is never met", async () => {
    // The first fix a phone reports is often a wifi or cell estimate that GPS
    // then refines. Sending that first one is what this sampler replaces.
    const g = fakeGeo();
    const progress: number[] = [];
    const box = track(
      sampleBestFix(g.geo, { ...OPTS, onProgress: (f) => progress.push(f.accuracyMeters) }),
    );

    g.fix(120);
    g.fix(45);
    g.fix(80); // worse than the best so far: ignored
    await vi.advanceTimersByTimeAsync(OPTS.settleMs - 1);
    expect(box.outcome).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(box.outcome).toMatchObject({ ok: true, fix: { accuracyMeters: 45 } });
    expect(progress).toEqual([120, 45]);
    expect(g.geo.clearWatch).toHaveBeenCalledTimes(1);
  });

  it("takes the first fix to arrive after the settle window instead of waiting out the timeout", async () => {
    const g = fakeGeo();
    const box = track(sampleBestFix(g.geo, OPTS));

    await vi.advanceTimersByTimeAsync(OPTS.settleMs + 2_000);
    expect(box.outcome).toBeUndefined();

    g.fix(70);
    await vi.advanceTimersByTimeAsync(0);
    expect(box.outcome).toMatchObject({ ok: true, fix: { accuracyMeters: 70 } });
  });

  it("times out when no fix ever arrives", async () => {
    const g = fakeGeo();
    const box = track(sampleBestFix(g.geo, OPTS));

    await vi.advanceTimersByTimeAsync(OPTS.timeoutMs - 1);
    expect(box.outcome).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(box.outcome).toEqual({ ok: false, reason: "TIMEOUT" });
    expect(g.geo.clearWatch).toHaveBeenCalledWith(7);
  });

  it("gives up at once when location permission is denied", async () => {
    const g = fakeGeo();
    const box = track(sampleBestFix(g.geo, OPTS));

    g.fail(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(box.outcome).toEqual({ ok: false, reason: "PERMISSION_DENIED" });
    expect(g.geo.clearWatch).toHaveBeenCalledWith(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rides out a transient POSITION_UNAVAILABLE and uses a later fix", async () => {
    // iOS reports "location unknown" while GPS is still acquiring, then
    // recovers. Ending the attempt there would fail people who are fine.
    const g = fakeGeo();
    const box = track(sampleBestFix(g.geo, OPTS));

    g.fail(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(box.outcome).toBeUndefined();

    g.fix(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(box.outcome).toMatchObject({ ok: true, fix: { accuracyMeters: 10 } });
  });

  it("reports POSITION_UNAVAILABLE at the timeout when that is all it ever heard", async () => {
    const g = fakeGeo();
    const box = track(sampleBestFix(g.geo, OPTS));

    g.fail(2);
    await vi.advanceTimersByTimeAsync(OPTS.timeoutMs);
    expect(box.outcome).toEqual({ ok: false, reason: "POSITION_UNAVAILABLE" });
  });

  it("ignores a fix that is not a real reading", async () => {
    const g = fakeGeo();
    const box = track(sampleBestFix(g.geo, OPTS));

    g.fix(NaN);
    g.fix(10, NaN, -72.9363);
    g.fix(-5);
    await vi.advanceTimersByTimeAsync(OPTS.timeoutMs);
    expect(box.outcome).toEqual({ ok: false, reason: "TIMEOUT" });
  });

  it("settles once, even if the browser keeps sending fixes", async () => {
    const g = fakeGeo();
    const box = track(sampleBestFix(g.geo, OPTS));

    g.fix(10);
    g.fix(5);
    await vi.advanceTimersByTimeAsync(OPTS.timeoutMs);
    expect(box.outcome).toMatchObject({ ok: true, fix: { accuracyMeters: 10 } });
    expect(g.geo.clearWatch).toHaveBeenCalledTimes(1);
  });

  it("clears the watch even when the browser answers synchronously", async () => {
    const geo = {
      watchPosition: vi.fn((success: PositionCallback) => {
        success({ coords: { latitude: 41.3026, longitude: -72.9363, accuracy: 5 } } as GeolocationPosition);
        return 9;
      }),
      clearWatch: vi.fn((_id: number) => {}),
    };
    const outcome = await sampleBestFix(geo, OPTS);
    expect(outcome.ok).toBe(true);
    expect(geo.clearWatch).toHaveBeenCalledWith(9);
  });
});
