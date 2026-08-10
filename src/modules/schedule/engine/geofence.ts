/**
 * Pure geofence math and pass rule for clinic check-in.
 *
 * Deliberately free of Prisma, settings, and request context so every boundary
 * can be exercised in unit tests. The caller resolves the configured centre and
 * thresholds and hands them in.
 *
 * This is a DETERRENT, not enforcement: a browser position is self-reported and
 * spoofable. The value is that the rule and the verdict live on the server, so a
 * client can lie about where it is but cannot move the fence or forge a pass.
 */

export type Coords = { latitude: number; longitude: number };

export type FenceInput = {
  position: Coords;
  /** The fix's reported accuracy radius, in metres (coords.accuracy). */
  accuracyMeters: number;
  centre: Coords;
  radiusMeters: number;
  maxAccuracyMeters: number;
};

export type FenceVerdict =
  | { ok: true; distanceMeters: number }
  | { ok: false; reason: "OUT_OF_RANGE" | "TOO_IMPRECISE"; distanceMeters: number };

const EARTH_RADIUS_M = 6371008.8; // IUGG mean radius

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in metres between two points. */
export function haversineMeters(a: Coords, b: Coords): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Apply the pass rule: near enough AND precise enough.
 *
 * The precision half is load-bearing. Indoors, coords.accuracy is routinely in
 * the hundreds of metres, and a fix meaning "somewhere in this half-kilometre"
 * is not evidence of presence OR of absence. Rather than silently passing or
 * silently failing it, we return TOO_IMPRECISE and let the caller route the
 * person to the director override.
 *
 * TOO_IMPRECISE is checked FIRST: when a fix is useless, reporting OUT_OF_RANGE
 * would assert a distance the data cannot support.
 */
export function evaluateFence(input: FenceInput): FenceVerdict {
  const distanceMeters = Math.round(haversineMeters(input.position, input.centre));

  if (input.accuracyMeters > input.maxAccuracyMeters) {
    return { ok: false, reason: "TOO_IMPRECISE", distanceMeters };
  }
  if (distanceMeters > input.radiusMeters) {
    return { ok: false, reason: "OUT_OF_RANGE", distanceMeters };
  }
  return { ok: true, distanceMeters };
}
