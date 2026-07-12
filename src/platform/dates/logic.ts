// UTC-only calendar utilities. These are NOT display helpers: isoDateKey is a
// comparison key and must never change zone. businessDaysSince gains an optional
// zone so "days pending" can be counted against clinic-local midnights.

/** Returns a UTC YYYY-MM-DD key for a date. */
export function isoDateKey(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function zonedYMD(d: Date, zone: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return [g("year"), g("month"), g("day")];
}

/**
 * Counts Monday to Friday business days elapsed between `start` and `now`,
 * exclusive of the start day and inclusive of `now`. Day boundaries use UTC by
 * default; pass `zone` to count against that zone's calendar days. Returns 0
 * when `now` is on or before `start`.
 */
export function businessDaysSince(start: Date, now: Date = new Date(), zone?: string): number {
  const dayMs = 86_400_000;
  const toDayUTC = (d: Date): number => {
    if (zone) {
      const [y, m, day] = zonedYMD(d, zone);
      return Date.UTC(y, m - 1, day);
    }
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  const startDay = toDayUTC(start);
  const endDay = toDayUTC(now);
  if (endDay <= startDay) return 0;

  let count = 0;
  for (let cursor = startDay + dayMs; cursor <= endDay; cursor += dayMs) {
    const dow = new Date(cursor).getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}
