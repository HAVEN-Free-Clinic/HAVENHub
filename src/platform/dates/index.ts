export * from "./zone";
export * from "./format";
export { isoDateKey, businessDaysSince } from "./logic";

// --- LEGACY SHIMS (removed in the final migration task) ---
// Preserve the exact old output so call sites keep compiling and rendering
// unchanged until each is migrated to a component or a zoned formatter.

/** @deprecated Use <CalendarDate>/<DateOnly> or formatCalendarDate/formatDateOnly. */
export function fmtDate(d: Date | null | undefined, fallback = "-"): string {
  if (!d) return fallback;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** @deprecated Use <DateTime> or formatDateTime. */
export function fmtDateTime(d: Date | null | undefined, fallback = "-"): string {
  if (!d) return fallback;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())} UTC`;
}
