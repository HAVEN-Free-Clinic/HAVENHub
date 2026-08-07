import { describe, it, expect } from "vitest";
import { haversineMeters, evaluateFence } from "./geofence";

// Yale Physicians Building, 800 Howard Avenue, New Haven CT.
const CLINIC = { latitude: 41.3025, longitude: -72.937 };

/**
 * Find a point due north of `base` whose haversineMeters distance from `base`
 * is `targetMeters`, via bisection against the engine's own distance function.
 *
 * A fixed latitude delta (e.g. "+0.01 degrees") does not land on a chosen
 * metre distance without knowing the earth-radius constant the engine uses
 * internally. Bisecting against `haversineMeters` itself sidesteps that: the
 * result is exact with respect to whatever formula and constant the engine
 * actually uses, with no hard-coded conversion factor to get out of sync.
 */
function pointAtDistanceNorth(base: typeof CLINIC, targetMeters: number): typeof CLINIC {
  let lo = 0;
  let hi = 0.01; // ~1.1 km due north, comfortably past any target used in these tests.
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const candidate = { latitude: base.latitude + mid, longitude: base.longitude };
    if (haversineMeters(base, candidate) < targetMeters) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return { latitude: base.latitude + hi, longitude: base.longitude };
}

describe("haversineMeters", () => {
  it("is zero for identical points", () => {
    expect(haversineMeters(CLINIC, CLINIC)).toBe(0);
  });

  it("is symmetric", () => {
    const other = { latitude: 41.31, longitude: -72.93 };
    expect(haversineMeters(CLINIC, other)).toBeCloseTo(haversineMeters(other, CLINIC), 6);
  });

  it("matches a known one-degree-of-latitude separation to within 0.5 percent", () => {
    // One degree of latitude is about 111,195 m anywhere on the sphere.
    const oneDegreeNorth = { latitude: CLINIC.latitude + 1, longitude: CLINIC.longitude };
    const d = haversineMeters(CLINIC, oneDegreeNorth);
    expect(d).toBeGreaterThan(111195 * 0.995);
    expect(d).toBeLessThan(111195 * 1.005);
  });

  it("measures a short local hop in the right ballpark", () => {
    // ~0.001 degrees of latitude is about 111 m.
    const d = haversineMeters(CLINIC, { latitude: CLINIC.latitude + 0.001, longitude: CLINIC.longitude });
    expect(d).toBeGreaterThan(105);
    expect(d).toBeLessThan(118);
  });
});

describe("evaluateFence", () => {
  const base = { centre: CLINIC, radiusMeters: 250, maxAccuracyMeters: 200 };

  it("passes a precise fix at the centre", () => {
    const v = evaluateFence({ ...base, position: CLINIC, accuracyMeters: 10 });
    expect(v).toEqual({ ok: true, distanceMeters: 0 });
  });

  it("rejects a precise fix beyond the radius", () => {
    const far = { latitude: CLINIC.latitude + 0.01, longitude: CLINIC.longitude }; // ~1.1 km
    const v = evaluateFence({ ...base, position: far, accuracyMeters: 10 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("OUT_OF_RANGE");
  });

  it("rejects an imprecise fix even when it is nominally inside the radius", () => {
    const v = evaluateFence({ ...base, position: CLINIC, accuracyMeters: 900 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("TOO_IMPRECISE");
  });

  it("reports TOO_IMPRECISE ahead of OUT_OF_RANGE when both apply", () => {
    // A useless fix is a useless fix; telling the volunteer they are far away
    // would be asserting something the data cannot support.
    const far = { latitude: CLINIC.latitude + 0.01, longitude: CLINIC.longitude };
    const v = evaluateFence({ ...base, position: far, accuracyMeters: 900 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("TOO_IMPRECISE");
  });

  it("treats the accuracy threshold as inclusive", () => {
    const atAccuracyLimit = evaluateFence({ ...base, position: CLINIC, accuracyMeters: 200 });
    expect(atAccuracyLimit.ok).toBe(true);

    const justOver = evaluateFence({ ...base, position: CLINIC, accuracyMeters: 201 });
    expect(justOver.ok).toBe(false);
  });

  it("treats the radius threshold as inclusive", () => {
    // Derive points at exactly the radius and one metre past it, rather than
    // guessing a lat/long offset, and confirm each lands where intended before
    // trusting the verdict it produces.
    const atRadius = pointAtDistanceNorth(CLINIC, base.radiusMeters);
    expect(haversineMeters(CLINIC, atRadius)).toBeCloseTo(base.radiusMeters, 3);
    const atLimit = evaluateFence({ ...base, position: atRadius, accuracyMeters: 10 });
    expect(atLimit.ok).toBe(true);

    const justBeyond = pointAtDistanceNorth(CLINIC, base.radiusMeters + 1);
    expect(haversineMeters(CLINIC, justBeyond)).toBeCloseTo(base.radiusMeters + 1, 3);
    const overLimit = evaluateFence({ ...base, position: justBeyond, accuracyMeters: 10 });
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) expect(overLimit.reason).toBe("OUT_OF_RANGE");
  });

  it("rounds the reported distance to whole metres", () => {
    const v = evaluateFence({
      ...base,
      position: { latitude: CLINIC.latitude + 0.0005, longitude: CLINIC.longitude },
      accuracyMeters: 10,
    });
    expect(Number.isInteger(v.distanceMeters)).toBe(true);
  });
});
