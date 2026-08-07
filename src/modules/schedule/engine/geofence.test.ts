import { describe, it, expect } from "vitest";
import { haversineMeters, evaluateFence } from "./geofence";

// Yale Physicians Building, 800 Howard Avenue, New Haven CT.
const CLINIC = { latitude: 41.3025, longitude: -72.937 };

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

  it("treats both thresholds as inclusive", () => {
    const atAccuracyLimit = evaluateFence({ ...base, position: CLINIC, accuracyMeters: 200 });
    expect(atAccuracyLimit.ok).toBe(true);

    const justOver = evaluateFence({ ...base, position: CLINIC, accuracyMeters: 201 });
    expect(justOver.ok).toBe(false);
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
