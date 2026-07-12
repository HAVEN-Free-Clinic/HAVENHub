import { getDisplayTimeZone } from "./resolve";
import { formatDateTime, formatDateOnly, formatTimeOnly, formatCalendarDate } from "./format";

type Props = {
  value: Date | null | undefined;
  fallback?: string;
  opts?: Intl.DateTimeFormatOptions;
};

/** Instant as date + time in the configured zone. */
export async function DateTime({ value, fallback = "-", opts }: Props) {
  if (!value) return <>{fallback}</>;
  const zone = await getDisplayTimeZone();
  return <time dateTime={value.toISOString()}>{formatDateTime(value, zone, opts)}</time>;
}

/** Instant as a calendar day in the configured zone. */
export async function DateOnly({ value, fallback = "-", opts }: Props) {
  if (!value) return <>{fallback}</>;
  const zone = await getDisplayTimeZone();
  return <time dateTime={value.toISOString()}>{formatDateOnly(value, zone, opts)}</time>;
}

/** Instant as a time in the configured zone. */
export async function TimeOnly({ value, fallback = "-", opts }: Props) {
  if (!value) return <>{fallback}</>;
  const zone = await getDisplayTimeZone();
  return <time dateTime={value.toISOString()}>{formatTimeOnly(value, zone, opts)}</time>;
}

/** Calendar-day marker in UTC (never zone-shifted). Sync: no resolve needed. */
export function CalendarDate({ value, fallback = "-", opts }: Props) {
  if (!value) return <>{fallback}</>;
  return <time dateTime={value.toISOString().slice(0, 10)}>{formatCalendarDate(value, opts)}</time>;
}
