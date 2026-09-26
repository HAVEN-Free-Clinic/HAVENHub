/**
 * Clinic dates arrive as YYYY-MM-DD calendar days. Build them at local noon so
 * no time zone can move them to the neighbouring day, then format locally.
 */
export function clinicDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

export function todayKey(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function formatClinicDate(key: string): string {
  return clinicDate(key).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function formatClinicDateLong(key: string): string {
  return clinicDate(key).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
