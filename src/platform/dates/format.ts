// Pure, framework-agnostic date formatting. Safe to import from server and
// client. Instant formatters require an explicit zone; calendar formatting is
// always UTC (see the design spec).

type Opts = Intl.DateTimeFormatOptions;

const DATE_TIME: Opts = {
  year: "numeric", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
};
const DATE_ONLY: Opts = { year: "numeric", month: "short", day: "numeric" };
const TIME_ONLY: Opts = { hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" };

/** Instant rendered in `zone` as date + time + zone abbreviation. */
export function formatDateTime(d: Date | null | undefined, zone: string, opts?: Opts, fallback = "-"): string {
  if (!d) return fallback;
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, ...(opts ?? DATE_TIME) }).format(d);
}

/** Instant rendered in `zone` as a calendar day (no time). */
export function formatDateOnly(d: Date | null | undefined, zone: string, opts?: Opts, fallback = "-"): string {
  if (!d) return fallback;
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, ...(opts ?? DATE_ONLY) }).format(d);
}

/** Instant rendered in `zone` as a time (with abbreviation). */
export function formatTimeOnly(d: Date | null | undefined, zone: string, opts?: Opts, fallback = "-"): string {
  if (!d) return fallback;
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, ...(opts ?? TIME_ONLY) }).format(d);
}

/** Calendar-day marker rendered in UTC, stable for noon- and midnight-UTC anchors. */
export function formatCalendarDate(d: Date | null | undefined, opts?: Opts, fallback = "-"): string {
  if (!d) return fallback;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...(opts ?? DATE_ONLY) }).format(d);
}

/** "EDT" / "EST" for the given instant in the given zone. */
export function zoneAbbrev(d: Date, zone: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

/** How far `zone` is ahead of UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = Number(p.value);
  const asUTC = Date.UTC(m.year, m.month - 1, m.day, m.hour, m.minute, m.second);
  return asUTC - instant.getTime();
}

/** Interpret a "YYYY-MM-DDTHH:mm" wall clock as being in `zone`; return the instant. */
export function parseZonedInput(wall: string, zone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!m) return null;
  const asUTC = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const off1 = zoneOffsetMs(new Date(asUTC), zone);
  let instant = new Date(asUTC - off1);
  const off2 = zoneOffsetMs(instant, zone);
  if (off2 !== off1) instant = new Date(asUTC - off2);
  return instant;
}

/** Instant to "YYYY-MM-DDTHH:mm" wall clock in `zone`, for a datetime-local input. */
export function formatForDateTimeInput(d: Date | null | undefined, zone: string): string {
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

/** Instant to "YYYY-MM-DD" wall clock in `zone`, for a date input's max/value. */
export function formatForDateInput(d: Date | null | undefined, zone: string): string {
  return formatForDateTimeInput(d, zone).slice(0, 10);
}
